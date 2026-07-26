'use strict';

const { globalShortcut } = require('electron/main');

const { HOTKEY_ACTIONS, DEFAULT_HOTKEYS } = require('./settings');

/**
 * Electron accelerators are not always spelled the way a browser keydown reports them,
 * so each binding is tried in a few equivalent forms before being reported as
 * unavailable.
 */
function getAcceleratorCandidates(accelerator) {
  const candidates = [accelerator];

  if (process.platform === 'win32' || process.platform === 'linux') {
    candidates.push(accelerator.replace(/\bCommandOrControl\b/g, 'Control'));
  }
  if (accelerator.includes('Esc')) {
    candidates.push(accelerator.replace(/\bEsc\b/g, 'Escape'));
  }
  if (accelerator.includes('Return')) {
    candidates.push(accelerator.replace(/\bReturn\b/g, 'Enter'));
  }

  return [...new Set(candidates.filter(Boolean))];
}

class HotkeyManager {
  constructor({ onTrigger }) {
    this.onTrigger = onTrigger;
    this.registrations = {};
  }

  register(hotkeys = {}) {
    globalShortcut.unregisterAll();
    this.registrations = {};

    const used = new Set();

    for (const action of HOTKEY_ACTIONS) {
      const accelerator = hotkeys[action];

      if (!accelerator) {
        this.registrations[action] = { registered: false, reason: 'disabled' };
        continue;
      }

      const key = accelerator.toLowerCase();
      if (used.has(key)) {
        this.registrations[action] = { registered: false, reason: 'duplicate' };
        continue;
      }
      used.add(key);

      let registered = false;
      let registeredAccelerator = null;
      let lastError = null;
      const candidates = getAcceleratorCandidates(accelerator);

      for (const candidate of candidates) {
        try {
          registered = globalShortcut.register(candidate, () => this.onTrigger(action));
        } catch (error) {
          lastError = error;
          registered = false;
        }
        if (registered) {
          registeredAccelerator = candidate;
          break;
        }
      }

      this.registrations[action] = {
        registered,
        accelerator: registeredAccelerator,
        candidates,
        reason: registered ? null : (lastError?.message || 'unavailable')
      };
    }

    return this.registrations;
  }

  dto(hotkeys) {
    return {
      hotkeys: { ...hotkeys },
      defaults: { ...DEFAULT_HOTKEYS },
      registrations: { ...this.registrations }
    };
  }

  unregisterAll() {
    globalShortcut.unregisterAll();
    this.registrations = {};
  }
}

module.exports = { HotkeyManager, getAcceleratorCandidates };
