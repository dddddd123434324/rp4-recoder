const state = {
  appInfo: null,
  sources: [],
  selectedSource: null,
  selectedMode: 'screen',
  modalMode: 'screen',
  previewStream: null,
  previewInputs: [],
  previewCleanup: null,
  recordingStream: null,
  recordingInputs: [],
  recordingCleanup: null,
  audioContext: null,
  audioNodes: [],
  mediaRecorder: null,
  sessionId: null,
  writeQueue: Promise.resolve(),
  isRecording: false,
  isPaused: false,
  startedAt: 0,
  timerId: null,
  toastTimer: null,
  hotkeys: {},
  hotkeyDefaults: {},
  hotkeyRegistrations: {},
  editingHotkey: null,
  clipRecorder: null,
  clipStream: null,
  clipInputs: [],
  clipCleanup: null,
  clipAudioContext: null,
  clipAudioNodes: [],
  clipChunks: [],
  clipSegmentChunks: [],
  clipSegmentStartedAt: 0,
  clipSegmentPromise: null,
  clipSegmentTimer: null,
  clipSegments: [],
  clipStopping: false,
  clipRotating: false,
  clipStartedAt: 0,
  clipSaving: false,
  areaSelection: {
    x: 0.15,
    y: 0.14,
    width: 0.58,
    height: 0.55
  },
  areaDrag: null
};

const presets = {
  low: {
    format: 'mp4',
    resolution: '1280x720',
    fps: '30',
    bitrate: '4',
    encoderPreset: 'superfast',
    audioBitrate: '128'
  },
  normal: {
    format: 'mp4',
    resolution: '1920x1080',
    fps: '60',
    bitrate: '10',
    encoderPreset: 'veryfast',
    audioBitrate: '192'
  },
  high: {
    format: 'mp4',
    resolution: '2560x1440',
    fps: '60',
    bitrate: '24',
    encoderPreset: 'faster',
    audioBitrate: '256'
  },
  game: {
    format: 'mp4',
    resolution: '1920x1080',
    fps: '120',
    bitrate: '35',
    encoderPreset: 'veryfast',
    audioBitrate: '256'
  }
};

const icons = {
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="13" rx="1.6"/><path d="M8 21h8M12 18v3"/></svg>'
};

const CLIP_SEGMENT_MS = 5000;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {};

window.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();

  state.appInfo = await window.rp4.appInfo();
  await loadHotkeys();
  setActivePreset('normal');
  updateVolumeLabels();
  updateRecordingUi();
  updateClipUi();

  if (state.appInfo.isSmoke) {
    setStatus('스모크 검사', '앱 로드가 완료되었습니다.', 'ready');
    await renderRecordings();
    return;
  }

  await refreshSources();
  await selectDefaultScreen();
  await renderRecordings();
}

function cacheElements() {
  Object.assign(els, {
    statusTitle: $('#statusTitle'),
    statusText: $('#statusText'),
    statusDot: $('.status-dot'),
    previewStage: $('#previewStage'),
    previewVideo: $('#previewVideo'),
    previewPlaceholder: $('#previewPlaceholder'),
    previewMeta: $('#previewMeta'),
    areaSelector: $('#areaSelector'),
    recordingPill: $('#recordingPill'),
    recordingTimer: $('#recordingTimer'),
    recordButton: $('#recordButton'),
    pauseButton: $('#pauseButton'),
    screenshotButton: $('#screenshotButton'),
    clipModeButton: $('#clipModeButton'),
    clipSaveButton: $('#clipSaveButton'),
    modeGrid: $('#modeGrid'),
    formatSelect: $('#formatSelect'),
    resolutionSelect: $('#resolutionSelect'),
    fpsSelect: $('#fpsSelect'),
    bitrateSelect: $('#bitrateSelect'),
    encoderPresetSelect: $('#encoderPresetSelect'),
    audioBitrateSelect: $('#audioBitrateSelect'),
    clipDurationInput: $('#clipDurationInput'),
    clipDurationUp: $('#clipDurationUp'),
    clipDurationDown: $('#clipDurationDown'),
    micToggle: $('#micToggle'),
    systemAudioToggle: $('#systemAudioToggle'),
    micVolume: $('#micVolume'),
    systemVolume: $('#systemVolume'),
    micVolumeLabel: $('#micVolumeLabel'),
    systemVolumeLabel: $('#systemVolumeLabel'),
    hotkeyGrid: $('#hotkeyGrid'),
    resetHotkeysButton: $('#resetHotkeysButton'),
    sourceModal: $('#sourceModal'),
    sourceGrid: $('#sourceGrid'),
    sourceModalTitle: $('#sourceModalTitle'),
    closeSourceModal: $('#closeSourceModal'),
    settingsModal: $('#settingsModal'),
    settingsModalTitle: $('#settingsModalTitle'),
    closeSettingsModal: $('#closeSettingsModal'),
    recordingList: $('#recordingList'),
    refreshFilesButton: $('#refreshFilesButton'),
    openFolderButton: $('#openFolderButton'),
    toast: $('#toast'),
    minimizeButton: $('#minimizeButton'),
    maximizeButton: $('#maximizeButton'),
    closeButton: $('#closeButton')
  });
}

function bindEvents() {
  els.recordButton.addEventListener('click', toggleRecording);
  els.pauseButton.addEventListener('click', togglePause);
  els.screenshotButton.addEventListener('click', takeScreenshot);
  els.clipModeButton.addEventListener('click', toggleClipMode);
  els.clipSaveButton.addEventListener('click', saveClip);
  els.refreshFilesButton?.addEventListener('click', renderRecordings);
  els.openFolderButton?.addEventListener('click', () => window.rp4.openRecordingsFolder());

  els.resetHotkeysButton.addEventListener('click', resetHotkeys);
  els.hotkeyGrid.addEventListener('click', (event) => {
    const button = event.target.closest('.hotkey-input');
    if (!button) return;
    startHotkeyCapture(button.dataset.hotkey);
  });
  document.addEventListener('keydown', captureHotkey);
  document.addEventListener('keydown', handleAssignedHotkey);
  document.addEventListener('keydown', handleGlobalKeydown);
  window.rp4.onHotkey(handleHotkey);

  els.modeGrid.addEventListener('click', async (event) => {
    const button = event.target.closest('.mode-card');
    if (!button) return;
    await setMode(button.dataset.mode);
  });

  els.closeSourceModal.addEventListener('click', closeSourceModal);
  els.sourceModal.addEventListener('click', (event) => {
    if (event.target === els.sourceModal) closeSourceModal();
  });
  els.closeSettingsModal.addEventListener('click', closeSettingsModal);
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) closeSettingsModal();
  });
  els.sourceGrid.addEventListener('click', async (event) => {
    const card = event.target.closest('.source-card');
    if (!card) return;
    const source = state.sources.find((item) => item.id === card.dataset.sourceId);
    if (!source) return;
    closeSourceModal();
    await chooseSource(source, state.modalMode);
  });

  [
    els.formatSelect,
    els.resolutionSelect,
    els.fpsSelect,
    els.bitrateSelect,
    els.encoderPresetSelect,
    els.audioBitrateSelect
  ].forEach((element) => {
    element.addEventListener('change', async () => {
      setActivePreset(null);
      updatePreviewMeta();
      pruneClipChunks();
      if (!state.isRecording && !state.clipStream && state.selectedSource) {
        await startPreview();
      }
    });
  });

  els.clipDurationInput.addEventListener('input', () => {
    pruneClipChunks();
    updateClipUi();
  });
  els.clipDurationInput.addEventListener('blur', () => {
    els.clipDurationInput.value = String(getProfile().clipDurationSeconds);
  });
  els.clipDurationUp.addEventListener('click', () => stepClipDuration(1));
  els.clipDurationDown.addEventListener('click', () => stepClipDuration(-1));

  els.micVolume.addEventListener('input', updateVolumeLabels);
  els.systemVolume.addEventListener('input', updateVolumeLabels);

  $$('.preset-card').forEach((button) => {
    button.addEventListener('click', async () => {
      await applyPreset(button.dataset.preset);
    });
  });

  $$('.section-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.settingsPopup) {
        openSettingsModal(button.dataset.settingsPopup);
        return;
      }

      const target = document.getElementById(button.dataset.collapseTarget);
      if (!target) return;
      const collapsed = target.classList.toggle('collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
    });
  });

  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'open-folder') await window.rp4.openRecordingsFolder();
    });
  });

  els.areaSelector?.addEventListener('pointerdown', startAreaDrag);
  document.addEventListener('pointermove', moveAreaDrag);
  document.addEventListener('pointerup', stopAreaDrag);
  window.addEventListener('resize', renderAreaSelector);
  els.previewVideo.addEventListener('loadedmetadata', renderAreaSelector);
  els.previewVideo.addEventListener('resize', renderAreaSelector);

  els.minimizeButton.addEventListener('click', () => window.rp4.window.minimize());
  els.maximizeButton.addEventListener('click', () => window.rp4.window.maximizeToggle());
  els.closeButton.addEventListener('click', () => window.rp4.window.close());
}

async function loadHotkeys() {
  try {
    const settings = await window.rp4.getHotkeys();
    applyHotkeySettings(settings);
  } catch (error) {
    console.error(error);
    showToast('단축키 설정을 불러오지 못했습니다.');
  }
}

function applyHotkeySettings(settings = {}) {
  state.hotkeys = settings.hotkeys || {};
  state.hotkeyDefaults = settings.defaults || {};
  state.hotkeyRegistrations = settings.registrations || {};
  renderHotkeys();
}

function renderHotkeys() {
  $$('.hotkey-input').forEach((button) => {
    const action = button.dataset.hotkey;
    const accelerator = state.hotkeys[action] || '';
    const registration = state.hotkeyRegistrations[action];
    const isCapturing = state.editingHotkey === action;

    button.textContent = isCapturing ? '입력 중...' : formatAccelerator(accelerator);
    button.classList.toggle('capturing', isCapturing);
    button.classList.toggle('unregistered', Boolean(accelerator && registration && !registration.registered));
    button.title = accelerator && registration && !registration.registered
      ? 'Windows나 다른 프로그램이 이미 사용 중인 조합입니다. RP4 창이 활성화되어 있을 때는 내부 단축키로 동작합니다.'
      : '';
  });
}

function startHotkeyCapture(action) {
  state.editingHotkey = action;
  renderHotkeys();
}

async function captureHotkey(event) {
  if (!state.editingHotkey) return;

  event.preventDefault();
  event.stopPropagation();

  const action = state.editingHotkey;
  if (event.key === 'Escape') {
    state.editingHotkey = null;
    renderHotkeys();
    return;
  }

  const hasModifier = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  if ((event.key === 'Backspace' || event.key === 'Delete') && !hasModifier) {
    await saveHotkey(action, '');
    return;
  }

  const accelerator = eventToAccelerator(event);
  if (!accelerator) return;
  await saveHotkey(action, accelerator);
}

async function handleAssignedHotkey(event) {
  if (state.editingHotkey || event.defaultPrevented) return;
  if (isTypingTarget(event.target)) return;

  const accelerator = eventToAccelerator(event, { silent: true });
  if (!accelerator) return;

  const signature = acceleratorSignature(accelerator);
  const entry = Object.entries(state.hotkeys).find(([, value]) => acceleratorSignature(value) === signature);
  if (!entry) return;

  event.preventDefault();
  event.stopPropagation();
  await handleHotkey(entry[0]);
}

function handleGlobalKeydown(event) {
  if (event.defaultPrevented) return;
  if (event.key !== 'Escape' || state.editingHotkey) return;
  if (!els.settingsModal.classList.contains('hidden')) {
    closeSettingsModal();
  }
}

async function saveHotkey(action, accelerator) {
  const next = {
    ...state.hotkeys,
    [action]: accelerator
  };

  if (accelerator && hasDuplicateHotkey(next)) {
    showToast('이미 사용 중인 단축키입니다.');
    state.editingHotkey = null;
    renderHotkeys();
    return;
  }

  try {
    const settings = await window.rp4.setHotkeys(next);
    state.editingHotkey = null;
    applyHotkeySettings(settings);
    const registration = state.hotkeyRegistrations[action];
    if (accelerator && registration && !registration.registered) {
      showToast('단축키를 저장했지만 Windows에서 등록하지 못했습니다.');
      return;
    }
    showToast(accelerator ? '단축키를 저장했습니다.' : '단축키를 비웠습니다.');
  } catch (error) {
    console.error(error);
    state.editingHotkey = null;
    renderHotkeys();
    showToast('단축키 저장에 실패했습니다.');
  }
}

async function resetHotkeys() {
  try {
    const settings = await window.rp4.resetHotkeys();
    state.editingHotkey = null;
    applyHotkeySettings(settings);
    showToast('단축키를 기본값으로 되돌렸습니다.');
  } catch (error) {
    console.error(error);
    showToast('단축키 초기화에 실패했습니다.');
  }
}

async function handleHotkey(action) {
  if (state.editingHotkey) return;

  if (action === 'recordToggle') {
    await toggleRecording();
    return;
  }

  if (action === 'pauseToggle') {
    togglePause();
    return;
  }

  if (action === 'screenshot') {
    await takeScreenshot();
    return;
  }

  if (action === 'clipToggle') {
    await toggleClipMode();
    return;
  }

  if (action === 'clipSave') {
    await saveClip();
  }
}

function hasDuplicateHotkey(hotkeys) {
  const seen = new Set();
  for (const accelerator of Object.values(hotkeys)) {
    if (!accelerator) continue;
    const key = accelerator.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
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
  const standaloneKey = functionKey || mediaKey || key === 'PrintScreen';
  const hasPrimaryModifier = event.ctrlKey || event.altKey || event.metaKey;
  if (!standaloneKey && !hasPrimaryModifier) {
    if (!silent) {
      showToast('문자/숫자 키는 Ctrl, Alt, Win 중 하나와 함께 지정해 주세요.');
    }
    return null;
  }

  return [...modifiers, key].join('+');
}

function normalizeKey(event) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    return null;
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
    return event.key.toUpperCase();
  }

  if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3);
  }

  if (/^Digit[0-9]$/.test(event.code)) {
    return event.code.slice(5);
  }

  if (/^Numpad[0-9]$/.test(event.code)) {
    return `num${event.code.slice(6)}`;
  }

  const punctuationKeys = new Set([')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '+', '=', '<', ',', '_', '-', '>', '.', '?', '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'"]);
  if (event.key.length === 1 && punctuationKeys.has(event.key)) {
    return event.key === '+' ? 'Plus' : event.key;
  }

  const keyMap = {
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

  return keyMap[event.code] || keyMap[event.key] || null;
}

function formatAccelerator(accelerator) {
  if (!accelerator) return '지정 안 함';
  return accelerator
    .replaceAll('CommandOrControl', 'Ctrl')
    .replaceAll('Return', 'Enter')
    .replaceAll('Esc', 'Escape')
    .replaceAll('+', ' + ');
}

function acceleratorSignature(accelerator = '') {
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

  const order = ['commandorcontrol', 'control', 'alt', 'shift', 'super', 'meta'];
  return parts.sort((a, b) => {
    const aIndex = order.includes(a) ? order.indexOf(a) : order.length;
    const bIndex = order.includes(b) ? order.indexOf(b) : order.length;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.localeCompare(b);
  }).join('+');
}

function isTypingTarget(target) {
  const element = target instanceof Element ? target : null;
  if (!element) return false;
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
}

function stepClipDuration(direction) {
  const current = getProfile().clipDurationSeconds;
  const next = clamp(current + direction, 1, 7200);
  els.clipDurationInput.value = String(next);
  pruneClipChunks();
  updateClipUi();
}

async function refreshSources() {
  try {
    state.sources = await window.rp4.listSources();
  } catch (error) {
    console.error(error);
    showToast('캡처 소스를 불러오지 못했습니다.');
  }
}

async function selectDefaultScreen() {
  const primary = getScreenSources().find((source) => source.display?.primary) || getScreenSources()[0];
  if (!primary) {
    setStatus('소스 없음', '캡처 가능한 화면을 찾지 못했습니다.', 'warn');
    return;
  }
  await chooseSource(primary, 'screen');
}

async function setMode(mode) {
  if (state.isRecording || state.clipStream) {
    showToast('녹화 중에는 캡처 모드를 바꿀 수 없습니다.');
    return;
  }

  if (mode === 'area') {
    await chooseDesktopArea();
    return;
  }

  if (mode === 'screen') {
    const source = getScreenSources().find((item) => item.display?.primary) || getScreenSources()[0];
    if (source) {
      await chooseSource(source, mode);
    }
    return;
  }

  await openSourceModal(mode);
}

async function chooseDesktopArea() {
  const previousMode = state.selectedMode;
  setActiveMode('area');
  setStatus('영역 선택', '실제 화면에서 녹화할 영역을 드래그하세요.', 'warn');

  let result = null;
  try {
    result = await window.rp4.selectArea();
  } catch (error) {
    console.error(error);
    showToast('영역 선택 화면을 열지 못했습니다.');
  }

  if (!result?.selection) {
    setActiveMode(previousMode);
    setStatus('준비 완료', '녹화 준비가 완료되었습니다.', 'ready');
    return;
  }

  await refreshSources();
  const source = getScreenSources().find((item) => String(item.displayId) === String(result.displayId))
    || getScreenSources().find((item) => item.display?.primary)
    || getScreenSources()[0];

  if (!source) {
    setActiveMode(previousMode);
    setStatus('소스 없음', '영역 녹화에 사용할 화면을 찾지 못했습니다.', 'warn');
    showToast('영역 녹화에 사용할 화면을 찾지 못했습니다.');
    return;
  }

  state.areaSelection = normalizeAreaSelection(result.selection);
  await chooseSource(source, 'area');
  showToast('영역 녹화 범위를 지정했습니다.');
}

async function openSourceModal(mode) {
  if (state.isRecording || state.clipStream) {
    showToast('녹화 중에는 소스를 바꿀 수 없습니다.');
    return;
  }

  state.modalMode = mode;
  await refreshSources();
  if (mode === 'window') {
    els.sourceModalTitle.textContent = '창 선택';
  } else if (mode === 'area') {
    els.sourceModalTitle.textContent = '영역 녹화 화면 선택';
  } else {
    els.sourceModalTitle.textContent = '모니터 선택';
  }
  renderSourceCards(mode);
  els.sourceModal.classList.remove('hidden');
}

function closeSourceModal() {
  els.sourceModal.classList.add('hidden');
}

function openSettingsModal(type) {
  const showHotkeys = type === 'hotkeys';
  const recordBody = document.getElementById('recordSettingsBody');
  const hotkeyBody = document.getElementById('hotkeySettingsBody');

  els.settingsModalTitle.textContent = showHotkeys ? '단축키' : '녹화 설정';
  recordBody.classList.toggle('hidden', showHotkeys);
  hotkeyBody.classList.toggle('hidden', !showHotkeys);
  els.settingsModal.classList.remove('hidden');

  $$('[data-settings-popup]').forEach((button) => {
    button.setAttribute('aria-expanded', String(button.dataset.settingsPopup === type));
  });

  if (showHotkeys) renderHotkeys();
}

function closeSettingsModal() {
  state.editingHotkey = null;
  els.settingsModal.classList.add('hidden');
  $$('[data-settings-popup]').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
  renderHotkeys();
}

function renderSourceCards(mode) {
  const sources = getSourcesForMode(mode);
  els.sourceGrid.replaceChildren();

  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '선택 가능한 소스가 없습니다.';
    els.sourceGrid.append(empty);
    return;
  }

  for (const source of sources) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'source-card';
    card.dataset.sourceId = source.id;
    if (source.id === state.selectedSource?.id) {
      card.classList.add('active');
    }

    if (source.thumbnail) {
      const img = document.createElement('img');
      img.src = source.thumbnail;
      img.alt = '';
      card.append(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'source-thumb-fallback';
      fallback.innerHTML = icons.video;
      card.append(fallback);
    }

    const title = document.createElement('strong');
    title.textContent = getSourceTitle(source);
    card.append(title);
    els.sourceGrid.append(card);
  }
}

async function chooseSource(source, mode = state.selectedMode) {
  state.selectedSource = source;
  state.selectedMode = mode;
  setActiveMode(mode);
  updateAreaSelectorVisibility();
  updatePreviewMeta();
  if (!state.isRecording && !state.clipStream) {
    await startPreview();
  }
}

function cleanupPreview() {
  if (state.previewCleanup) {
    state.previewCleanup();
  }
  stopStream(state.previewStream);
  for (const stream of state.previewInputs) {
    stopStream(stream);
  }
  state.previewStream = null;
  state.previewInputs = [];
  state.previewCleanup = null;
}

async function prepareVideoOutput(inputStream, source, options = {}) {
  const videoTracks = inputStream.getVideoTracks();
  const videoTrack = videoTracks[0];
  if (!videoTrack) {
    throw new Error('영상 트랙을 찾을 수 없습니다.');
  }
  videoTrack.contentHint = 'motion';

  const cropArea = Boolean(options.cropArea && state.selectedMode === 'area');
  const cropWindow = Boolean(source?.type === 'window' && !cropArea);

  if (!cropArea && !cropWindow) {
    return {
      stream: new MediaStream([videoTrack]),
      cleanup: null,
      cropped: false
    };
  }

  let windowCrop = null;
  if (cropWindow) {
    windowCrop = await window.rp4.getWindowClientCrop(source.id);
    if (!windowCrop) {
      showToast('창 내부 영역을 찾지 못해 창 전체를 사용합니다.');
      return {
        stream: new MediaStream([videoTrack]),
        cleanup: null,
        cropped: false
      };
    }
  }

  const rawVideo = document.createElement('video');
  rawVideo.muted = true;
  rawVideo.playsInline = true;
  rawVideo.srcObject = new MediaStream([videoTrack]);
  await waitForVideoReady(rawVideo);
  await rawVideo.play();

  const profile = getProfile();
  const firstCrop = cropArea
    ? areaSelectionToCrop(rawVideo.videoWidth, rawVideo.videoHeight)
    : scaleCrop(windowCrop, rawVideo.videoWidth, rawVideo.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = firstCrop.width;
  canvas.height = firstCrop.height;
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const output = canvas.captureStream(profile.fps);
  output.getVideoTracks().forEach((track) => {
    track.contentHint = 'motion';
  });
  let stopped = false;
  let frameId = 0;

  const draw = () => {
    if (stopped) return;

    if (rawVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && rawVideo.videoWidth && rawVideo.videoHeight) {
      const scaledCrop = cropArea
        ? areaSelectionToCrop(rawVideo.videoWidth, rawVideo.videoHeight)
        : scaleCrop(windowCrop, rawVideo.videoWidth, rawVideo.videoHeight);
      if (canvas.width !== scaledCrop.width || canvas.height !== scaledCrop.height) {
        canvas.width = scaledCrop.width;
        canvas.height = scaledCrop.height;
      }

      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        rawVideo,
        scaledCrop.x,
        scaledCrop.y,
        scaledCrop.sourceWidth,
        scaledCrop.sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height
      );
    }

    scheduleDraw();
  };

  const scheduleDraw = () => {
    if (stopped) return;
    if (rawVideo.requestVideoFrameCallback) {
      frameId = rawVideo.requestVideoFrameCallback(draw);
    } else {
      frameId = requestAnimationFrame(draw);
    }
  };
  scheduleDraw();

  return {
    stream: output,
    cropped: true,
    cleanup: () => {
      stopped = true;
      if (rawVideo.cancelVideoFrameCallback) {
        rawVideo.cancelVideoFrameCallback(frameId);
      } else {
        cancelAnimationFrame(frameId);
      }
      rawVideo.pause();
      rawVideo.srcObject = null;
      stopStream(output);
    }
  };
}

function waitForVideoReady(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('영상 정보를 읽는 시간이 초과되었습니다.'));
    }, 5000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener('loadedmetadata', handleReady);
      video.removeEventListener('resize', handleReady);
      video.removeEventListener('error', handleError);
    };
    const handleReady = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('영상 정보를 읽을 수 없습니다.'));
    };

    video.addEventListener('loadedmetadata', handleReady);
    video.addEventListener('resize', handleReady);
    video.addEventListener('error', handleError);
  });
}

function scaleCrop(crop, videoWidth, videoHeight) {
  const scaleX = videoWidth / Math.max(1, crop.frameWidth);
  const scaleY = videoHeight / Math.max(1, crop.frameHeight);
  const x = clamp(Math.round(crop.x * scaleX), 0, Math.max(0, videoWidth - 1));
  const y = clamp(Math.round(crop.y * scaleY), 0, Math.max(0, videoHeight - 1));
  const width = clamp(Math.round(crop.width * scaleX), 1, Math.max(1, videoWidth - x));
  const height = clamp(Math.round(crop.height * scaleY), 1, Math.max(1, videoHeight - y));
  return {
    x,
    y,
    sourceWidth: width,
    sourceHeight: height,
    width: makeEven(width),
    height: makeEven(height)
  };
}

function areaSelectionToCrop(videoWidth, videoHeight) {
  const selection = normalizeAreaSelection(state.areaSelection);
  const x = clamp(Math.round(selection.x * videoWidth), 0, Math.max(0, videoWidth - 1));
  const y = clamp(Math.round(selection.y * videoHeight), 0, Math.max(0, videoHeight - 1));
  const width = clamp(Math.round(selection.width * videoWidth), 1, Math.max(1, videoWidth - x));
  const height = clamp(Math.round(selection.height * videoHeight), 1, Math.max(1, videoHeight - y));
  return {
    x,
    y,
    sourceWidth: width,
    sourceHeight: height,
    width: makeEven(width),
    height: makeEven(height)
  };
}

function normalizeAreaSelection(selection) {
  const minSize = 0.06;
  const width = clamp(selection.width, minSize, 1);
  const height = clamp(selection.height, minSize, 1);
  return {
    x: clamp(selection.x, 0, 1 - width),
    y: clamp(selection.y, 0, 1 - height),
    width,
    height
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeEven(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

async function startPreview() {
  if (!state.selectedSource || state.isRecording || state.clipStream) return;

  cleanupPreview();
  let desktopStream = null;

  try {
    desktopStream = await getDesktopStream(state.selectedSource, { audio: false });
    const output = await prepareVideoOutput(desktopStream, state.selectedSource, { cropArea: false });
    state.previewInputs = [desktopStream];
    state.previewStream = output.stream;
    state.previewCleanup = output.cleanup;
    els.previewVideo.srcObject = output.stream;
    els.previewVideo.muted = true;
    await playPreview();
    els.previewPlaceholder.classList.add('hidden');
    updatePreviewMeta();
    updateAreaSelectorVisibility();
    setStatus('준비 완료', '녹화 준비가 완료되었습니다.', 'ready');
  } catch (error) {
    console.error(error);
    if (desktopStream) {
      stopStream(desktopStream);
    }
    cleanupPreview();
    els.previewPlaceholder.classList.remove('hidden');
    setStatus('미리보기 실패', '선택한 소스를 열 수 없습니다.', 'warn');
    showToast('미리보기를 시작하지 못했습니다. 다른 소스를 선택해 주세요.');
  }
}

async function getDesktopStream(source, { audio }) {
  const profile = getProfile();
  const highDetailCapture = source?.type === 'window' || state.selectedMode === 'area';
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      maxWidth: highDetailCapture ? Math.max(profile.width, 3840) : profile.width,
      maxHeight: highDetailCapture ? Math.max(profile.height, 2160) : profile.height,
      maxFrameRate: profile.fps
    }
  };

  if (!audio) {
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id
        }
      },
      video
    });
  } catch (error) {
    console.warn('시스템 오디오 캡처 실패, 영상만 사용합니다.', error);
    showToast('시스템 오디오는 이 소스에서 사용할 수 없어 영상만 녹화합니다.');
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }
}

async function createCaptureStream({ audio, cropArea }) {
  const desktopStream = await getDesktopStream(state.selectedSource, { audio });
  const inputs = [desktopStream];
  const videoOutput = await prepareVideoOutput(desktopStream, state.selectedSource, { cropArea });
  const output = new MediaStream(videoOutput.stream.getVideoTracks());
  const audioInputs = [];
  const audioNodes = [];
  let audioContext = null;

  if (audio && desktopStream.getAudioTracks().length > 0) {
    audioInputs.push({
      stream: new MediaStream(desktopStream.getAudioTracks()),
      gain: Number(els.systemVolume.value) / 100
    });
  }

  if (els.micToggle.checked) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false
        }
      });
      inputs.push(micStream);
      audioInputs.push({
        stream: micStream,
        gain: Number(els.micVolume.value) / 100
      });
    } catch (error) {
      console.warn(error);
      showToast('마이크를 열 수 없어 마이크 없이 녹화합니다.');
    }
  }

  if (audioInputs.length > 0) {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    for (const input of audioInputs) {
      const source = audioContext.createMediaStreamSource(input.stream);
      const gain = audioContext.createGain();
      gain.gain.value = input.gain;
      source.connect(gain).connect(destination);
      audioNodes.push(source, gain);
    }

    destination.stream.getAudioTracks().forEach((track) => output.addTrack(track));
  }

  return {
    stream: output,
    inputs,
    cleanup: videoOutput.cleanup,
    audioContext,
    audioNodes
  };
}

async function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
    return;
  }
  await startRecording();
}

async function startRecording() {
  if (state.isRecording) return;

  if (state.clipStream) {
    showToast('클립 녹화 모드를 중지한 뒤 일반 녹화를 시작해 주세요.');
    return;
  }

  if (!state.selectedSource) {
    await selectDefaultScreen();
  }
  if (!state.selectedSource) return;

  let session = null;
  try {
    setStatus('녹화 준비 중', '캡처 스트림을 준비하고 있습니다.', 'warn');
    cleanupPreview();

    const capture = await createCaptureStream({
      audio: els.systemAudioToggle.checked,
      cropArea: state.selectedMode === 'area'
    });
    state.recordingStream = capture.stream;
    state.recordingInputs = capture.inputs;
    state.recordingCleanup = capture.cleanup;
    state.audioContext = capture.audioContext;
    state.audioNodes = capture.audioNodes;

    els.previewVideo.srcObject = capture.stream;
    els.previewVideo.muted = true;
    await playPreview();
    els.previewPlaceholder.classList.add('hidden');

    const profile = getProfile();
    const videoSettings = capture.stream.getVideoTracks()[0]?.getSettings?.() || {};
    session = await window.rp4.startRecording({
      mode: state.selectedMode,
      modeLabel: getModeLabel(state.selectedMode),
      sourceName: getSourceTitle(state.selectedSource),
      format: profile.format,
      width: videoSettings.width || profile.width,
      height: videoSettings.height || profile.height,
      fps: profile.fps,
      bitrateMbps: profile.bitrateMbps,
      encoderPreset: profile.encoderPreset,
      audioBitrateKbps: profile.audioBitrateKbps
    });

    const recorder = new MediaRecorder(capture.stream, getRecorderOptions(profile));
    state.mediaRecorder = recorder;
    state.sessionId = session.sessionId;
    state.writeQueue = Promise.resolve();
    state.isRecording = true;
    state.isPaused = false;
    state.startedAt = Date.now();

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        enqueueChunk(event.data);
      }
    });
    recorder.addEventListener('error', (event) => {
      console.error(event.error || event);
      showToast('녹화 중 오류가 발생했습니다.');
    });
    recorder.addEventListener('stop', finalizeRecording, { once: true });

    recorder.start(1000);
    updateRecordingUi();
    startTimer();
    setStatus('녹화 중', `${getSourceTitle(state.selectedSource)} 녹화 중입니다.`, 'recording');
  } catch (error) {
    console.error(error);
    if (session?.sessionId) {
      await window.rp4.stopRecording({ sessionId: session.sessionId });
    }
    cleanupRecordingState();
    updateRecordingUi();
    await startPreview();
    setStatus('녹화 실패', '녹화를 시작하지 못했습니다.', 'warn');
    showToast('녹화를 시작하지 못했습니다. 캡처 소스와 권한을 확인해 주세요.');
  }
}

function enqueueChunk(blob) {
  const sessionId = state.sessionId;
  state.writeQueue = state.writeQueue
    .then(async () => {
      const buffer = await blob.arrayBuffer();
      await window.rp4.writeRecordingChunk({ sessionId, buffer });
    })
    .catch((error) => {
      console.error(error);
      showToast('녹화 데이터를 저장하던 중 오류가 발생했습니다.');
    });
}

function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') return;
  setStatus('저장 중', '녹화 파일을 마무리하고 있습니다.', 'warn');
  state.mediaRecorder.stop();
}

async function finalizeRecording() {
  const sessionId = state.sessionId;
  try {
    await state.writeQueue;
    const saved = await window.rp4.stopRecording({ sessionId });
    cleanupRecordingState();
    updateRecordingUi();
    await renderRecordings();
    await startPreview();
    setStatus('저장 완료', saved ? saved.name : '녹화 파일이 저장되었습니다.', 'ready');
    if (saved) {
      showToast(`저장 완료: ${saved.name}`);
    }
  } catch (error) {
    console.error(error);
    cleanupRecordingState();
    updateRecordingUi();
    await startPreview();
    setStatus('저장 실패', '녹화 파일 저장을 완료하지 못했습니다.', 'warn');
    showToast('녹화 파일 저장을 완료하지 못했습니다.');
  }
}

function togglePause() {
  const recorder = state.mediaRecorder;
  if (!recorder || !state.isRecording) return;

  if (recorder.state === 'recording') {
    recorder.pause();
    state.isPaused = true;
    els.pauseButton.querySelector('span').textContent = '재개';
    setStatus('일시정지', '녹화가 일시정지되었습니다.', 'warn');
    updateAreaSelectorState();
    return;
  }

  if (recorder.state === 'paused') {
    recorder.resume();
    state.isPaused = false;
    els.pauseButton.querySelector('span').textContent = '일시정지';
    setStatus('녹화 중', `${getSourceTitle(state.selectedSource)} 녹화 중입니다.`, 'recording');
    updateAreaSelectorState();
  }
}

async function toggleClipMode() {
  if (state.clipStream) {
    await stopClipMode();
    return;
  }
  await startClipMode();
}

async function startClipMode() {
  if (state.isRecording) {
    showToast('일반 녹화 중에는 클립 녹화 모드를 시작할 수 없습니다.');
    return;
  }

  if (!state.selectedSource) {
    await selectDefaultScreen();
  }
  if (!state.selectedSource) return;

  try {
    setStatus('클립 모드 준비 중', '최근 장면 버퍼를 준비하고 있습니다.', 'warn');
    cleanupPreview();

    const capture = await createCaptureStream({
      audio: els.systemAudioToggle.checked,
      cropArea: state.selectedMode === 'area'
    });

    state.clipStream = capture.stream;
    state.clipInputs = capture.inputs;
    state.clipCleanup = capture.cleanup;
    state.clipAudioContext = capture.audioContext;
    state.clipAudioNodes = capture.audioNodes;
    state.clipChunks = [];
    state.clipSegments = [];
    state.clipSegmentChunks = [];
    state.clipSegmentStartedAt = 0;
    state.clipStopping = false;
    state.clipStartedAt = Date.now();

    els.previewVideo.srcObject = capture.stream;
    els.previewVideo.muted = true;
    await playPreview();
    els.previewPlaceholder.classList.add('hidden');

    startClipSegment();
    startTimer();
    updateClipUi();
    setStatus('클립 녹화 중', `${getClipDurationLabel()} 버퍼를 유지하고 있습니다.`, 'recording');
  } catch (error) {
    console.error(error);
    cleanupClipState();
    updateClipUi();
    await startPreview();
    setStatus('클립 모드 실패', '클립 녹화 모드를 시작하지 못했습니다.', 'warn');
    showToast('클립 녹화 모드를 시작하지 못했습니다.');
  }
}

function startClipSegment() {
  if (!state.clipStream || state.clipStopping) return;

  const recorder = new MediaRecorder(state.clipStream, getRecorderOptions(getProfile()));
  state.clipRecorder = recorder;
  state.clipSegmentChunks = [];
  state.clipSegmentStartedAt = Date.now();

  state.clipSegmentPromise = new Promise((resolve) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        state.clipSegmentChunks.push(event.data);
      }
    });
    recorder.addEventListener('error', (event) => {
      console.error(event.error || event);
      showToast('클립 녹화 중 오류가 발생했습니다.');
    });
    recorder.addEventListener('stop', () => {
      clearTimeout(state.clipSegmentTimer);
      state.clipSegmentTimer = null;

      const endedAt = Date.now();
      const chunks = state.clipSegmentChunks.slice();
      const segment = chunks.length > 0
        ? {
            blob: new Blob(chunks, { type: pickMimeType() || 'video/webm' }),
            startedAt: state.clipSegmentStartedAt,
            endedAt
          }
        : null;

      state.clipRecorder = null;
      state.clipSegmentChunks = [];
      state.clipSegmentStartedAt = 0;
      state.clipSegmentPromise = null;
      resolve(segment);
    }, { once: true });
  });

  recorder.start(250);
  state.clipSegmentTimer = window.setTimeout(() => {
    rotateClipSegment().catch((error) => {
      console.error(error);
      showToast('클립 버퍼 순환 중 오류가 발생했습니다.');
    });
  }, CLIP_SEGMENT_MS);
}

async function stopCurrentClipSegment({ keep = true } = {}) {
  const recorder = state.clipRecorder;
  const promise = state.clipSegmentPromise;
  clearTimeout(state.clipSegmentTimer);
  state.clipSegmentTimer = null;

  if (!recorder || recorder.state === 'inactive') {
    return null;
  }

  try {
    if (recorder.state === 'recording') {
      recorder.requestData();
    }
  } catch {
    // 일부 Chromium 빌드에서 stop 직전 requestData가 실패할 수 있습니다.
  }

  recorder.stop();
  const segment = promise ? await promise : null;
  return keep ? segment : null;
}

async function rotateClipSegment() {
  if (state.clipRotating || !state.clipRecorder || state.clipStopping) return;

  state.clipRotating = true;
  try {
    const segment = await stopCurrentClipSegment({ keep: true });
    if (segment) {
      state.clipSegments.push(segment);
      pruneClipChunks();
    }
    if (state.clipStream && !state.clipStopping) {
      startClipSegment();
    }
  } finally {
    state.clipRotating = false;
  }
}

function pruneClipChunks(now = Date.now()) {
  const profile = getProfile();
  const marginMs = Math.max(CLIP_SEGMENT_MS * 2, 2000);
  const cutoff = now - profile.clipDurationSeconds * 1000 - marginMs;
  state.clipSegments = state.clipSegments.filter((segment) => segment.endedAt >= cutoff);
  state.clipChunks = [];
}

async function stopClipMode() {
  if (!state.clipStream) return;
  setStatus('클립 모드 중지 중', '클립 버퍼를 정리하고 있습니다.', 'warn');
  state.clipStopping = true;
  await stopCurrentClipSegment({ keep: false });
  cleanupClipState();
  updateClipUi();
  await startPreview();
}

async function saveClip() {
  if (!state.clipStream || state.clipSaving) return;

  state.clipSaving = true;
  updateClipUi();

  try {
    while (state.clipRotating) {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    }
    const profile = getProfile();
    const currentSegment = await stopCurrentClipSegment({ keep: true });
    const savePoint = Date.now();
    if (currentSegment) {
      state.clipSegments.push(currentSegment);
    }
    pruneClipChunks(savePoint);

    const cutoff = savePoint - profile.clipDurationSeconds * 1000;
    const recent = state.clipSegments.filter((segment) => segment.endedAt > cutoff && segment.startedAt <= savePoint);
    if (!recent.length) {
      state.clipSegments = [];
      state.clipStartedAt = savePoint;
      startClipSegment();
      showToast('아직 저장할 클립 데이터가 없습니다.');
      return;
    }

    const firstSegment = recent[0];
    const trimStartMs = Math.max(0, cutoff - firstSegment.startedAt);
    const durationMs = Math.min(
      profile.clipDurationSeconds * 1000,
      Math.max(0, savePoint - Math.max(cutoff, firstSegment.startedAt))
    );
    const segments = await Promise.all(recent.map(async (segment) => ({
      buffer: await segment.blob.arrayBuffer(),
      startedAt: segment.startedAt,
      endedAt: segment.endedAt
    })));
    const videoSettings = state.clipStream?.getVideoTracks()[0]?.getSettings?.() || {};
    state.clipSegments = [];
    state.clipStartedAt = savePoint;
    updateTimer();
    startClipSegment();

    setStatus('클립 저장 중', '최근 장면을 파일로 저장하고 있습니다.', 'warn');
    const saved = await window.rp4.saveClip({
      segments,
      trimStartMs,
      meta: {
        mode: state.selectedMode,
        modeLabel: `${getModeLabel(state.selectedMode)} 클립`,
        sourceName: getSourceTitle(state.selectedSource),
        format: profile.format,
        width: videoSettings.width || profile.width,
        height: videoSettings.height || profile.height,
        fps: profile.fps,
        bitrateMbps: profile.bitrateMbps,
        encoderPreset: 'ultrafast',
        audioBitrateKbps: profile.audioBitrateKbps,
        durationMs,
        clip: true
      }
    });

    await renderRecordings();
    setStatus('클립 녹화 중', `${getClipDurationLabel()} 버퍼를 유지하고 있습니다.`, 'recording');
    showToast(`클립 저장 완료: ${saved.name}`);
  } catch (error) {
    console.error(error);
    setStatus('클립 저장 실패', '클립 파일 저장을 완료하지 못했습니다.', 'warn');
    showToast('클립 파일 저장을 완료하지 못했습니다.');
  } finally {
    state.clipSaving = false;
    updateClipUi();
  }
}

function flushClipData() {
  return stopCurrentClipSegment({ keep: true });
}

async function takeScreenshot() {
  try {
    if (!els.previewVideo.videoWidth && state.selectedSource && !state.isRecording && !state.clipStream) {
      await startPreview();
    }

    const canvas = drawPreviewFrameToCanvas(state.selectedMode === 'area' && !state.isRecording && !state.clipStream);
    if (!canvas) {
      showToast('스크린샷을 저장할 미리보기 화면이 없습니다.');
      return;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const buffer = await blob.arrayBuffer();
    const saved = await window.rp4.saveScreenshot({
      buffer,
      width: canvas.width,
      height: canvas.height
    });
    showToast(`스크린샷 저장: ${saved.fileName}`);
  } catch (error) {
    console.error(error);
    showToast('스크린샷 저장에 실패했습니다.');
  }
}

function drawPreviewFrameToCanvas(cropArea) {
  const width = els.previewVideo.videoWidth;
  const height = els.previewVideo.videoHeight;
  if (!width || !height) return null;

  const crop = cropArea
    ? areaSelectionToCrop(width, height)
    : { x: 0, y: 0, sourceWidth: width, sourceHeight: height, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext('2d');
  context.drawImage(
    els.previewVideo,
    crop.x,
    crop.y,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvas;
}

async function renderRecordings() {
  if (!els.recordingList) return;

  try {
    const recordings = await window.rp4.listRecordings();
    els.recordingList.replaceChildren();

    if (!recordings.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '아직 녹화 파일이 없습니다.';
      els.recordingList.append(empty);
      return;
    }

    for (const recording of recordings.slice(0, 8)) {
      els.recordingList.append(createRecordingItem(recording));
    }
  } catch (error) {
    console.error(error);
    showToast('녹화 파일 목록을 불러오지 못했습니다.');
  }
}

function createRecordingItem(recording) {
  const item = document.createElement('div');
  item.className = 'recording-item';

  const thumb = document.createElement('div');
  thumb.className = 'recording-thumb';
  thumb.innerHTML = icons.video;

  const info = document.createElement('div');
  info.className = 'recording-info';
  const name = document.createElement('strong');
  name.textContent = recording.name;
  const detail = document.createElement('small');
  detail.textContent = [
    formatDuration(recording.durationMs),
    recording.width && recording.height ? `${recording.width}x${recording.height}` : null,
    recording.fps ? `${recording.fps} FPS` : null,
    formatBytes(recording.size)
  ].filter(Boolean).join(' · ');
  info.append(name, detail);

  const actions = document.createElement('div');
  actions.className = 'recording-actions';
  const date = document.createElement('small');
  date.textContent = formatDate(recording.createdAt);
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '...';
  open.title = '파일 위치 열기';
  open.addEventListener('click', () => window.rp4.showFile(recording.filePath));
  actions.append(date, open);

  item.append(thumb, info, actions);
  return item;
}

async function applyPreset(key) {
  if (state.isRecording || state.clipStream) {
    showToast('녹화 중에는 프리셋을 바꿀 수 없습니다.');
    return;
  }

  const preset = presets[key];
  if (!preset) return;

  els.formatSelect.value = preset.format;
  els.resolutionSelect.value = preset.resolution;
  els.fpsSelect.value = preset.fps;
  els.bitrateSelect.value = preset.bitrate;
  els.encoderPresetSelect.value = preset.encoderPreset;
  els.audioBitrateSelect.value = preset.audioBitrate;
  setActivePreset(key);
  updatePreviewMeta();

  if (state.selectedSource) {
    await startPreview();
  }
}

function setActivePreset(key) {
  $$('.preset-card').forEach((button) => {
    button.classList.toggle('active', button.dataset.preset === key);
  });
}

function setActiveMode(mode) {
  $$('.mode-card').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
}

function getSourcesForMode(mode) {
  if (mode === 'window') {
    return state.sources.filter((source) => source.type === 'window');
  }
  return getScreenSources();
}

function getScreenSources() {
  return state.sources.filter((source) => source.type === 'screen');
}

function getSourceTitle(source) {
  if (!source) return '소스 없음';
  if (source.type === 'screen') {
    const index = source.display?.index || getScreenSources().findIndex((item) => item.id === source.id) + 1;
    return source.display?.primary ? `모니터 ${index} (주 화면)` : `모니터 ${index}`;
  }
  return source.name || '창';
}

function getModeLabel(mode) {
  if (mode === 'window') return '창 지정';
  if (mode === 'monitor') return '특정 모니터';
  if (mode === 'area') return '영역 녹화';
  return '전체 화면';
}

function getProfile() {
  const [width, height] = els.resolutionSelect.value.split('x').map(Number);
  return {
    format: els.formatSelect.value,
    width,
    height,
    fps: Number(els.fpsSelect.value),
    bitrateMbps: Number(els.bitrateSelect.value),
    encoderPreset: els.encoderPresetSelect.value,
    audioBitrateKbps: Number(els.audioBitrateSelect.value),
    clipDurationSeconds: clamp(Number(els.clipDurationInput.value) || 1, 1, 7200)
  };
}

function getRecorderOptions(profile) {
  const mimeType = pickMimeType();
  const options = {
    videoBitsPerSecond: profile.bitrateMbps * 1000 * 1000,
    audioBitsPerSecond: profile.audioBitrateKbps * 1000
  };
  if (mimeType) {
    options.mimeType = mimeType;
  }
  return options;
}

function updatePreviewMeta() {
  const profile = getProfile();
  const source = getSourceTitle(state.selectedSource);
  els.previewMeta.textContent = `${profile.width} x ${profile.height} | ${profile.fps} FPS | ${profile.format.toUpperCase()} | ${source}`;
}

function updateVolumeLabels() {
  els.micVolumeLabel.textContent = `${els.micVolume.value}%`;
  els.systemVolumeLabel.textContent = `${els.systemVolume.value}%`;
}

function pickMimeType() {
  return [
    'video/webm; codecs=vp8,opus',
    'video/webm; codecs=vp9,opus',
    'video/webm'
  ].find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function updateRecordingUi() {
  const recording = state.isRecording;
  els.recordButton.classList.toggle('recording', recording);
  els.recordButton.querySelector('span').textContent = recording ? 'STOP' : 'REC';
  els.recordButton.disabled = Boolean(state.clipStream);
  els.pauseButton.disabled = !recording;
  els.pauseButton.querySelector('span').textContent = state.isPaused ? '재개' : '일시정지';
  els.recordingPill.classList.toggle('hidden', !recording && !state.clipStream);
  updateAreaSelectorState();
}

function updateClipUi() {
  const active = Boolean(state.clipStream);
  els.clipModeButton.classList.toggle('active', active);
  els.clipModeButton.querySelector('span').textContent = active ? '클립 녹화 모드 중지' : '클립 녹화 모드 시작';
  els.clipSaveButton.disabled = !active || state.clipSaving;
  els.clipSaveButton.querySelector('span').textContent = state.clipSaving ? '클립 저장 중' : '클립 저장';
  els.recordButton.disabled = active;
  els.recordingPill.classList.toggle('hidden', !active && !state.isRecording);
  updateAreaSelectorState();
}

function startTimer() {
  stopTimer();
  updateTimer();
  state.timerId = window.setInterval(updateTimer, 500);
}

function stopTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function updateTimer() {
  const base = state.isRecording ? state.startedAt : state.clipStream ? state.clipStartedAt : 0;
  const elapsed = base ? Math.max(0, Date.now() - base) : 0;
  els.recordingTimer.textContent = formatDuration(elapsed);
}

function cleanupRecordingState() {
  stopTimer();
  if (state.recordingCleanup) {
    state.recordingCleanup();
  }
  stopStream(state.recordingStream);
  for (const stream of state.recordingInputs) {
    stopStream(stream);
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
  }

  state.recordingStream = null;
  state.recordingInputs = [];
  state.recordingCleanup = null;
  state.audioContext = null;
  state.audioNodes = [];
  state.mediaRecorder = null;
  state.sessionId = null;
  state.writeQueue = Promise.resolve();
  state.isRecording = false;
  state.isPaused = false;
  state.startedAt = 0;
}

function cleanupClipState() {
  stopTimer();
  clearTimeout(state.clipSegmentTimer);
  if (state.clipCleanup) {
    state.clipCleanup();
  }
  stopStream(state.clipStream);
  for (const stream of state.clipInputs) {
    stopStream(stream);
  }
  if (state.clipAudioContext) {
    state.clipAudioContext.close().catch(() => {});
  }

  state.clipRecorder = null;
  state.clipStream = null;
  state.clipInputs = [];
  state.clipCleanup = null;
  state.clipAudioContext = null;
  state.clipAudioNodes = [];
  state.clipChunks = [];
  state.clipSegmentChunks = [];
  state.clipSegmentStartedAt = 0;
  state.clipSegmentPromise = null;
  state.clipSegmentTimer = null;
  state.clipSegments = [];
  state.clipStopping = false;
  state.clipRotating = false;
  state.clipStartedAt = 0;
  state.clipSaving = false;
  setStatus('준비 완료', '녹화 준비가 완료되었습니다.', 'ready');
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

async function playPreview() {
  try {
    await els.previewVideo.play();
  } catch (error) {
    console.warn(error);
  }
}

function setStatus(title, text, tone = 'ready') {
  els.statusTitle.textContent = title;
  els.statusText.textContent = text;
  els.statusDot.classList.toggle('recording', tone === 'recording');
  els.statusDot.classList.toggle('warn', tone === 'warn');
}

function updateAreaSelectorVisibility() {
  if (!els.areaSelector) return;
  els.areaSelector.classList.add('hidden');
}

function updateAreaSelectorState() {
  if (!els.areaSelector) return;
  els.areaSelector.classList.toggle('recording', (state.isRecording && !state.isPaused) || Boolean(state.clipStream));
  updateAreaSelectorVisibility();
}

function getVideoDisplayRect() {
  const stageRect = els.previewStage.getBoundingClientRect();
  const videoWidth = els.previewVideo.videoWidth || 16;
  const videoHeight = els.previewVideo.videoHeight || 9;
  const stageAspect = stageRect.width / Math.max(1, stageRect.height);
  const videoAspect = videoWidth / Math.max(1, videoHeight);

  let width = stageRect.width;
  let height = stageRect.height;
  let left = 0;
  let top = 0;

  if (videoAspect > stageAspect) {
    height = width / videoAspect;
    top = (stageRect.height - height) / 2;
  } else {
    width = height * videoAspect;
    left = (stageRect.width - width) / 2;
  }

  return { left, top, width, height };
}

function renderAreaSelector() {
  if (!els.areaSelector || state.selectedMode !== 'area') return;
  if (els.areaSelector.classList.contains('hidden')) return;
  state.areaSelection = normalizeAreaSelection(state.areaSelection);
  const rect = getVideoDisplayRect();
  const selection = state.areaSelection;
  els.areaSelector.style.left = `${rect.left + selection.x * rect.width}px`;
  els.areaSelector.style.top = `${rect.top + selection.y * rect.height}px`;
  els.areaSelector.style.width = `${selection.width * rect.width}px`;
  els.areaSelector.style.height = `${selection.height * rect.height}px`;
}

function startAreaDrag(event) {
  if (state.selectedMode !== 'area') return;
  event.preventDefault();
  els.areaSelector.setPointerCapture?.(event.pointerId);
  state.areaDrag = {
    pointerId: event.pointerId,
    handle: event.target.dataset.handle || 'move',
    startX: event.clientX,
    startY: event.clientY,
    startSelection: { ...state.areaSelection },
    rect: getVideoDisplayRect()
  };
}

function moveAreaDrag(event) {
  if (!state.areaDrag || event.pointerId !== state.areaDrag.pointerId) return;
  const drag = state.areaDrag;
  const dx = (event.clientX - drag.startX) / Math.max(1, drag.rect.width);
  const dy = (event.clientY - drag.startY) / Math.max(1, drag.rect.height);
  const minSize = 0.06;
  const start = drag.startSelection;
  let { x, y, width, height } = start;

  if (drag.handle === 'move') {
    x = clamp(start.x + dx, 0, 1 - start.width);
    y = clamp(start.y + dy, 0, 1 - start.height);
  } else {
    if (drag.handle.includes('e')) {
      width = clamp(start.width + dx, minSize, 1 - start.x);
    }
    if (drag.handle.includes('s')) {
      height = clamp(start.height + dy, minSize, 1 - start.y);
    }
    if (drag.handle.includes('w')) {
      const right = start.x + start.width;
      x = clamp(start.x + dx, 0, right - minSize);
      width = right - x;
    }
    if (drag.handle.includes('n')) {
      const bottom = start.y + start.height;
      y = clamp(start.y + dy, 0, bottom - minSize);
      height = bottom - y;
    }
  }

  state.areaSelection = normalizeAreaSelection({ x, y, width, height });
  renderAreaSelector();
}

function stopAreaDrag(event) {
  if (!state.areaDrag || event.pointerId !== state.areaDrag.pointerId) return;
  els.areaSelector.releasePointerCapture?.(event.pointerId);
  state.areaDrag = null;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 3600);
}

function getClipDurationLabel() {
  const seconds = getProfile().clipDurationSeconds;
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}
