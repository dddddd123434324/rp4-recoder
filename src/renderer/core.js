'use strict';

/*
 * Shared renderer state, element cache and small helpers.
 *
 * The renderer is split across several classic scripts sharing a single `RP4` namespace.
 * ES modules are not used because Chromium blocks module fetches from file:// origins.
 * Load order is defined by the <script> tags in index.html.
 */
window.RP4 = window.RP4 || {};

(function initCore(RP4) {
  const state = {
    appInfo: null,
    sources: [],
    selectedSource: null,
    selectedMode: 'screen',
    modalMode: 'screen',

    // Preview
    preview: null,
    previewGeneration: 0,

    // Shared capture lifecycle. Recording and clip mode must claim this synchronously
    // before their first await so two starts can never overlap.
    captureLifecycle: 'idle',
    captureOperationId: 0,

    // Normal recording
    recording: null,
    isRecording: false,
    isPaused: false,
    startedAt: 0,
    pausedAccumMs: 0,
    pausedAt: 0,

    // Clip mode
    clip: null,
    clipSaving: false,

    timerId: null,
    toastTimer: null,

    appSettings: {
      selectedPreset: 'normal',
      customPresets: [],
      profile: null,
      recordingsDir: '',
      optimizeMp4: true,
      clipBufferLimitMb: 256,
      maxCustomPresets: 48
    },
    selectedPreset: 'normal',

    hotkeys: {},
    hotkeyDefaults: {},
    hotkeyRegistrations: {},
    editingHotkey: null,

    areaSelection: { x: 0, y: 0, width: 1, height: 1 },
    hasAreaSelection: false,

    profileSaveTimer: null
  };

  const els = {};

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /** H.264 requires even dimensions; chroma planes are half resolution. */
  function makeEven(value) {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
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

  function formatSeconds(seconds) {
    if (seconds < 60) return `${seconds}초`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
  }

  function showToast(message, { durationMs = 3600 } = {}) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.add('hidden');
    }, durationMs);
  }

  function setStatus(title, text, tone = 'ready') {
    if (!els.statusTitle) return;
    els.statusTitle.textContent = title;
    els.statusText.textContent = text;
    els.statusDot.classList.toggle('recording', tone === 'recording');
    els.statusDot.classList.toggle('warn', tone === 'warn');
  }

  function isTypingTarget(target) {
    const element = target instanceof Element ? target : null;
    if (!element) return false;
    return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function beginCapture(phase) {
    if (state.captureLifecycle !== 'idle') return null;
    state.captureOperationId += 1;
    state.captureLifecycle = phase;
    return state.captureOperationId;
  }

  function isCurrentCapture(operationId, phase = null) {
    return state.captureOperationId === operationId
      && (phase == null || state.captureLifecycle === phase);
  }

  function transitionCapture(operationId, phase) {
    if (!isCurrentCapture(operationId)) return false;
    state.captureLifecycle = phase;
    return true;
  }

  function finishCapture(operationId) {
    if (!isCurrentCapture(operationId)) return false;
    state.captureLifecycle = 'idle';
    return true;
  }

  function captureBusy() {
    return state.captureLifecycle !== 'idle';
  }

  const IPC_SLICE_BYTES = 8 * 1024 * 1024;

  async function writeBlobInSlices(sessionId, blob) {
    for (let offset = 0; offset < blob.size; offset += IPC_SLICE_BYTES) {
      const part = blob.slice(offset, Math.min(blob.size, offset + IPC_SLICE_BYTES));
      const result = await window.rp4.writeRecordingChunk({
        sessionId,
        buffer: await part.arrayBuffer()
      });
      if (result?.warning) return result;
    }
    return null;
  }

  RP4.state = state;
  RP4.els = els;
  RP4.$ = $;
  RP4.$$ = $$;
  RP4.util = {
    clamp,
    makeEven,
    formatBytes,
    formatDuration,
    formatDate,
    formatSeconds,
    isTypingTarget,
    stopStream,
    sleep,
    writeBlobInSlices
  };
  RP4.lifecycle = {
    begin: beginCapture,
    isCurrent: isCurrentCapture,
    transition: transitionCapture,
    finish: finishCapture,
    isBusy: captureBusy
  };
  RP4.ui = { showToast, setStatus };
}(window.RP4));
