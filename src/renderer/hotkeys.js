'use strict';

/*
 * Hotkey capture and dispatch.
 *
 * Global shortcuts are registered by the main process. When Windows or another app already
 * owns a combination, registration fails and the same binding still works as a local
 * shortcut while the RP4 window has focus.
 */
(function initHotkeys(RP4) {
  const { state, util } = RP4;

  const PUNCTUATION = new Set([
    ')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '+', '=', '<', ',', '_',
    '-', '>', '.', '?', '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'"
  ]);

  const KEY_MAP = {
    Backspace: 'Backspace',
    Space: 'Space',
    Tab: 'Tab',
    CapsLock: 'Capslock',
    NumLock: 'Numlock',
    ScrollLock: 'Scrolllock',
    Enter: 'Return',
    Escape: 'Esc',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    PrintScreen: 'PrintScreen',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
    AudioVolumeUp: 'VolumeUp',
    AudioVolumeDown: 'VolumeDown',
    AudioVolumeMute: 'VolumeMute',
    MediaTrackNext: 'MediaNextTrack',
    MediaTrackPrevious: 'MediaPreviousTrack',
    MediaStop: 'MediaStop',
    MediaPlayPause: 'MediaPlayPause'
  };

  function normalizeKey(event) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key.toUpperCase();
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
    if (/^Numpad[0-9]$/.test(event.code)) return `num${event.code.slice(6)}`;
    if (event.key.length === 1 && PUNCTUATION.has(event.key)) {
      return event.key === '+' ? 'Plus' : event.key;
    }
    return KEY_MAP[event.code] || KEY_MAP[event.key] || null;
  }

  function eventToAccelerator(event, { silent = false } = {}) {
    const key = normalizeKey(event);
    if (!key) return null;

    const modifiers = [];
    if (event.ctrlKey) modifiers.push('CommandOrControl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Super');

    const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    const mediaKey = /^Media|^Volume/.test(key);
    const standalone = functionKey || mediaKey || key === 'PrintScreen';
    const hasPrimaryModifier = event.ctrlKey || event.altKey || event.metaKey;

    if (!standalone && !hasPrimaryModifier) {
      if (!silent) {
        RP4.ui.showToast('문자/숫자 키는 Ctrl, Alt, Win 중 하나와 함께 지정해 주세요.');
      }
      return null;
    }

    return [...modifiers, key].join('+');
  }

  /** Order-insensitive comparison so "Alt+Shift+K" matches "Shift+Alt+K". */
  function signature(accelerator = '') {
    const parts = String(accelerator)
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .map((part) => {
        if (part === 'control' || part === 'ctrl') return 'commandorcontrol';
        if (part === 'escape') return 'esc';
        if (part === 'enter') return 'return';
        return part;
      });

    const order = ['commandorcontrol', 'alt', 'shift', 'super', 'meta'];
    return parts.sort((a, b) => {
      const aIndex = order.includes(a) ? order.indexOf(a) : order.length;
      const bIndex = order.includes(b) ? order.indexOf(b) : order.length;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.localeCompare(b);
    }).join('+');
  }

  function format(accelerator) {
    if (!accelerator) return '지정 안 함';
    return accelerator
      .replaceAll('CommandOrControl', 'Ctrl')
      .replaceAll('Return', 'Enter')
      .replaceAll('Esc', 'Escape')
      .replaceAll('+', ' + ');
  }

  function render() {
    for (const button of RP4.$$('.hotkey-input')) {
      const action = button.dataset.hotkey;
      const accelerator = state.hotkeys[action] || '';
      const registration = state.hotkeyRegistrations[action];
      const capturing = state.editingHotkey === action;
      const unregistered = Boolean(accelerator && registration && !registration.registered);

      button.textContent = capturing ? '입력 중...' : format(accelerator);
      button.classList.toggle('capturing', capturing);
      button.classList.toggle('unregistered', unregistered);
      button.title = unregistered
        ? 'Windows나 다른 프로그램이 이미 사용 중인 조합입니다. RP4 창이 활성화되어 있을 때는 내부 단축키로 동작합니다.'
        : '';
    }
  }

  function apply(settings = {}) {
    state.hotkeys = settings.hotkeys || {};
    state.hotkeyDefaults = settings.defaults || {};
    state.hotkeyRegistrations = settings.registrations || {};
    render();
  }

  async function load() {
    try {
      apply(await window.rp4.getHotkeys());
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('단축키 설정을 불러오지 못했습니다.');
    }
  }

  function startCapture(action) {
    state.editingHotkey = action;
    render();
  }

  function hasDuplicate(hotkeys) {
    const seen = new Set();
    for (const accelerator of Object.values(hotkeys)) {
      if (!accelerator) continue;
      const key = signature(accelerator);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  async function save(action, accelerator) {
    const next = { ...state.hotkeys, [action]: accelerator };

    if (accelerator && hasDuplicate(next)) {
      RP4.ui.showToast('이미 사용 중인 단축키입니다.');
      state.editingHotkey = null;
      render();
      return;
    }

    try {
      const settings = await window.rp4.setHotkeys(next);
      state.editingHotkey = null;
      apply(settings);

      const registration = state.hotkeyRegistrations[action];
      if (accelerator && registration && !registration.registered) {
        RP4.ui.showToast('단축키를 저장했지만 Windows에서 등록하지 못했습니다.');
        return;
      }
      RP4.ui.showToast(accelerator ? '단축키를 저장했습니다.' : '단축키를 비웠습니다.');
    } catch (error) {
      console.error(error);
      state.editingHotkey = null;
      render();
      RP4.ui.showToast('단축키 저장에 실패했습니다.');
    }
  }

  async function reset() {
    try {
      const settings = await window.rp4.resetHotkeys();
      state.editingHotkey = null;
      apply(settings);
      RP4.ui.showToast('단축키를 기본값으로 되돌렸습니다.');
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('단축키 초기화에 실패했습니다.');
    }
  }

  async function capture(event) {
    if (!state.editingHotkey) return;

    event.preventDefault();
    event.stopPropagation();

    const action = state.editingHotkey;
    if (event.key === 'Escape') {
      state.editingHotkey = null;
      render();
      return;
    }

    const hasModifier = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
    if ((event.key === 'Backspace' || event.key === 'Delete') && !hasModifier) {
      await save(action, '');
      return;
    }

    const accelerator = eventToAccelerator(event);
    if (!accelerator) return;
    await save(action, accelerator);
  }

  /** Runs the action for a hotkey, whether it arrived globally or locally. */
  async function dispatch(action) {
    if (state.editingHotkey || state.sourceSelectionPending || RP4.dialog.isDialogOpen()) return;
    if (!RP4.els.sourceModal?.classList.contains('hidden')) return;

    if (action === 'recordToggle') {
      await RP4.recorder.toggleRecording();
      return;
    }
    if (action === 'pauseToggle') {
      RP4.recorder.togglePause();
      return;
    }
    if (action === 'screenshot') {
      await RP4.files.takeScreenshot();
      return;
    }
    if (action === 'clipToggle') {
      await RP4.clips.toggleClipMode();
      return;
    }
    if (action === 'clipSave') {
      await RP4.clips.saveClip();
    }
  }

  /**
   * Local fallback for bindings the OS refused to register globally. When registration did
   * succeed the key never reaches the renderer, so this cannot double-fire.
   */
  async function handleLocal(event) {
    if (state.editingHotkey || event.defaultPrevented) return;
    if (RP4.dialog.isDialogOpen()) return;
    if (util.isTypingTarget(event.target)) return;

    const accelerator = eventToAccelerator(event, { silent: true });
    if (!accelerator) return;

    const target = signature(accelerator);
    const entry = Object.entries(state.hotkeys).find(([action, value]) => {
      if (!value || signature(value) !== target) return false;
      const registration = state.hotkeyRegistrations[action];
      return registration?.registered === false
        && registration.reason !== 'disabled'
        && registration.reason !== 'duplicate';
    });
    if (!entry) return;

    event.preventDefault();
    event.stopPropagation();
    await dispatch(entry[0]);
  }

  RP4.hotkeys = {
    load,
    apply,
    render,
    startCapture,
    capture,
    handleLocal,
    dispatch,
    reset,
    format
  };
}(window.RP4));
