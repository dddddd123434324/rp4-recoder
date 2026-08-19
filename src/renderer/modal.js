'use strict';

/*
 * In-app replacements for window.prompt and window.confirm.
 *
 * Electron does not implement window.prompt: calling it throws
 * "prompt() is not supported.". Because the preset handlers were wired straight to click
 * listeners, that rejection was swallowed and the "create preset" and "edit preset"
 * buttons silently did nothing.
 */
(function initModal(RP4) {
  let activeDialog = null;

  function buildDialog({ title, message, defaultValue, placeholder, confirmLabel, cancelLabel, withInput }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal dialog-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'modal-card dialog-card';
    const headingId = `rp4-dialog-title-${crypto.randomUUID()}`;
    card.setAttribute('aria-labelledby', headingId);

    const header = document.createElement('div');
    header.className = 'panel-header';
    const heading = document.createElement('h2');
    heading.id = headingId;
    heading.textContent = RP4.i18n.translate(title);
    header.append(heading);

    const body = document.createElement('div');
    body.className = 'dialog-body';

    if (message) {
      const text = document.createElement('p');
      text.textContent = RP4.i18n.translate(message);
      body.append(text);
    }

    let input = null;
    if (withInput) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'dialog-input';
      input.value = defaultValue || '';
      input.placeholder = RP4.i18n.translate(placeholder || '');
      input.maxLength = 40;
      input.setAttribute('aria-label', title);
      body.append(input);
    }

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dialog-button';
    cancel.textContent = RP4.i18n.translate(cancelLabel || '취소');
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'dialog-button primary';
    confirm.textContent = RP4.i18n.translate(confirmLabel || '확인');
    actions.append(cancel, confirm);

    card.append(header, body, actions);
    overlay.append(card);

    return { overlay, card, input, cancel, confirm };
  }

  function open(options) {
    // Only one dialog at a time; a second request cancels the first.
    if (activeDialog) {
      activeDialog.settle(null);
    }

    return new Promise((resolve) => {
      const parts = buildDialog(options);
      const previousFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      let settled = false;

      const settle = (value) => {
        if (settled) return;
        settled = true;
        activeDialog = null;
        document.removeEventListener('keydown', onKeyDown, true);
        parts.overlay.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(value);
      };

      function onKeyDown(event) {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          settle(null);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey
          && (event.target === parts.confirm || event.target === parts.input)) {
          event.preventDefault();
          event.stopPropagation();
          settle(parts.input ? parts.input.value : true);
          return;
        }
        if (event.key === 'Tab') {
          const focusable = [parts.input, parts.cancel, parts.confirm].filter(Boolean);
          const current = focusable.indexOf(document.activeElement);
          const next = event.shiftKey
            ? (current <= 0 ? focusable.length - 1 : current - 1)
            : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
          event.preventDefault();
          focusable[next].focus();
        }
      }

      parts.cancel.addEventListener('click', () => settle(null));
      parts.confirm.addEventListener('click', () => settle(parts.input ? parts.input.value : true));
      parts.overlay.addEventListener('mousedown', (event) => {
        if (event.target === parts.overlay) settle(null);
      });
      // Captured so the global hotkey handlers cannot act on typing inside the dialog.
      document.addEventListener('keydown', onKeyDown, true);

      activeDialog = { settle };
      document.body.append(parts.overlay);

      if (parts.input) {
        parts.input.focus();
        parts.input.select();
      } else {
        parts.confirm.focus();
      }
    });
  }

  /** Resolves with the trimmed string, or null when cancelled or left empty. */
  async function promptText({ title, message, defaultValue = '', placeholder = '', confirmLabel = '저장' }) {
    const value = await open({
      title,
      message,
      defaultValue,
      placeholder,
      confirmLabel,
      withInput: true
    });
    if (value === null) return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  }

  async function confirmAction({ title, message, confirmLabel = '확인', cancelLabel = '취소' }) {
    const value = await open({ title, message, confirmLabel, cancelLabel, withInput: false });
    return value === true;
  }

  function isDialogOpen() {
    return Boolean(activeDialog);
  }

  RP4.dialog = { promptText, confirmAction, isDialogOpen };
}(window.RP4));
