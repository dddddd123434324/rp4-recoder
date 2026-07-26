'use strict';

/*
 * Recording profile (the form values) plus built-in and user presets.
 */
(function initProfile(RP4) {
  const { state, els, util } = RP4;

  const BUILTIN_PRESETS = {
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

  /** Reads the live form values. */
  function get() {
    const [width, height] = String(els.resolutionSelect.value).split('x').map(Number);
    return {
      format: els.formatSelect.value === 'webm' ? 'webm' : 'mp4',
      width: Number.isFinite(width) ? width : 1920,
      height: Number.isFinite(height) ? height : 1080,
      fps: Number(els.fpsSelect.value) || 60,
      bitrateMbps: Number(els.bitrateSelect.value) || 10,
      encoderPreset: els.encoderPresetSelect.value,
      audioBitrateKbps: Number(els.audioBitrateSelect.value) || 192,
      micEnabled: els.micToggle.checked,
      systemAudioEnabled: els.systemAudioToggle.checked,
      micVolume: Number(els.micVolume.value),
      systemVolume: Number(els.systemVolume.value),
      clipDurationSeconds: util.clamp(Number(els.clipDurationInput.value) || 1, 1, 7200)
    };
  }

  /** Shape used for persistence and for saving presets. */
  function getPersistable() {
    const profile = get();
    return {
      format: profile.format,
      resolution: `${profile.width}x${profile.height}`,
      fps: String(profile.fps),
      bitrate: String(profile.bitrateMbps),
      encoderPreset: profile.encoderPreset,
      audioBitrate: String(profile.audioBitrateKbps),
      micEnabled: profile.micEnabled,
      systemAudioEnabled: profile.systemAudioEnabled,
      micVolume: profile.micVolume,
      systemVolume: profile.systemVolume,
      clipDurationSeconds: profile.clipDurationSeconds
    };
  }

  function setSelectValue(select, value) {
    if (!select || value == null) return;
    const next = String(value);
    if ([...select.options].some((option) => option.value === next)) {
      select.value = next;
    }
  }

  function applyToForm(profile = {}) {
    setSelectValue(els.formatSelect, profile.format);
    setSelectValue(els.resolutionSelect, profile.resolution);
    setSelectValue(els.fpsSelect, profile.fps);
    setSelectValue(els.bitrateSelect, profile.bitrate);
    setSelectValue(els.encoderPresetSelect, profile.encoderPreset);
    setSelectValue(els.audioBitrateSelect, profile.audioBitrate);

    if (typeof profile.micEnabled === 'boolean') els.micToggle.checked = profile.micEnabled;
    if (typeof profile.systemAudioEnabled === 'boolean') {
      els.systemAudioToggle.checked = profile.systemAudioEnabled;
    }
    if (Number.isFinite(Number(profile.micVolume))) {
      els.micVolume.value = String(util.clamp(Number(profile.micVolume), 0, 100));
    }
    if (Number.isFinite(Number(profile.systemVolume))) {
      els.systemVolume.value = String(util.clamp(Number(profile.systemVolume), 0, 100));
    }
    if (Number.isFinite(Number(profile.clipDurationSeconds))) {
      els.clipDurationInput.value = String(util.clamp(Number(profile.clipDurationSeconds), 1, 7200));
    }
  }

  function getPresetByKey(key) {
    if (BUILTIN_PRESETS[key]) return { profile: BUILTIN_PRESETS[key] };
    const id = String(key || '').startsWith('custom:') ? String(key).slice(7) : null;
    if (!id) return null;
    return state.appSettings.customPresets.find((preset) => preset.id === id) || null;
  }

  function setActivePreset(key) {
    state.selectedPreset = key || null;
    for (const button of RP4.$$('.preset-card')) {
      const cardKey = button.dataset.presetKey || button.dataset.preset;
      button.classList.toggle('active', cardKey === key);
    }
  }

  /**
   * Persists the live profile, debounced. Previously only the selected preset key was
   * saved, so any ad-hoc tweak silently reverted on the next launch.
   */
  function scheduleProfileSave() {
    window.clearTimeout(state.profileSaveTimer);
    state.profileSaveTimer = window.setTimeout(async () => {
      try {
        await window.rp4.saveProfile(getPersistable());
      } catch {
        // Non-fatal: the session keeps working with the in-memory values.
      }
    }, 400);
  }

  /** Applies volume changes to a live recording instead of only to the next one. */
  function applyLiveGains() {
    const profile = get();
    for (const session of [state.recording, state.clip]) {
      if (!session?.gains) continue;
      if (session.gains.mic) session.gains.mic.gain.value = profile.micVolume / 100;
      if (session.gains.system) session.gains.system.gain.value = profile.systemVolume / 100;
    }
  }

  function markChanged({ persist = true } = {}) {
    setActivePreset(null);
    RP4.app.updatePreviewMeta();
    applyLiveGains();
    if (persist) scheduleProfileSave();
  }

  async function applyPreset(key, { persist = true } = {}) {
    if (state.isRecording || state.clip) {
      RP4.ui.showToast('녹화 중에는 프리셋을 바꿀 수 없습니다.');
      return;
    }

    const preset = getPresetByKey(key);
    if (!preset) return;

    applyToForm(preset.profile || preset);
    setActivePreset(key);
    RP4.app.updateVolumeLabels();
    RP4.app.updatePreviewMeta();
    RP4.app.updateClipUi();

    if (persist) {
      try {
        const settings = await window.rp4.setSelectedPreset(key);
        RP4.app.applyAppSettings(settings);
        setActivePreset(key);
      } catch {
        RP4.ui.showToast('선택한 프리셋을 저장하지 못했습니다.');
      }
      scheduleProfileSave();
    }

    if (state.selectedSource) {
      await RP4.recorder.restartPreview();
    }
  }

  function defaultPresetName() {
    return `사용자 프리셋 ${state.appSettings.customPresets.length + 1}`;
  }

  async function createCustomPreset() {
    if (state.appSettings.customPresets.length >= state.appSettings.maxCustomPresets) {
      RP4.ui.showToast(`프리셋은 최대 ${state.appSettings.maxCustomPresets}개까지 만들 수 있습니다.`);
      return;
    }

    const name = await RP4.dialog.promptText({
      title: '새 프리셋',
      message: '현재 녹화 설정을 새 프리셋으로 저장합니다.',
      defaultValue: defaultPresetName(),
      placeholder: '프리셋 이름'
    });
    if (!name) return;

    try {
      const settings = await window.rp4.saveCustomPreset({ name, profile: getPersistable() });
      RP4.app.applyAppSettings(settings);
      await applyPreset(settings.selectedPreset, { persist: false });
      RP4.ui.showToast('프리셋을 생성했습니다.');
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('프리셋을 저장하지 못했습니다.');
    }
  }

  async function updateCustomPreset(id) {
    const preset = state.appSettings.customPresets.find((item) => item.id === id);
    if (!preset) return;

    const name = await RP4.dialog.promptText({
      title: '프리셋 수정',
      message: '이름을 바꾸고 현재 녹화 설정으로 덮어씁니다.',
      defaultValue: preset.name,
      placeholder: '프리셋 이름'
    });
    if (!name) return;

    try {
      const settings = await window.rp4.saveCustomPreset({ id, name, profile: getPersistable() });
      RP4.app.applyAppSettings(settings);
      await applyPreset(`custom:${id}`, { persist: false });
      RP4.ui.showToast('프리셋을 수정했습니다.');
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('프리셋을 수정하지 못했습니다.');
    }
  }

  async function deleteCustomPreset(id) {
    const preset = state.appSettings.customPresets.find((item) => item.id === id);
    if (!preset) return;

    const confirmed = await RP4.dialog.confirmAction({
      title: '프리셋 삭제',
      message: `"${preset.name}" 프리셋을 삭제할까요?`,
      confirmLabel: '삭제'
    });
    if (!confirmed) return;

    try {
      const settings = await window.rp4.deleteCustomPreset(id);
      RP4.app.applyAppSettings(settings);
      if (settings.selectedPreset) {
        await applyPreset(settings.selectedPreset, { persist: false });
      }
      RP4.ui.showToast('프리셋을 삭제했습니다.');
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('프리셋을 삭제하지 못했습니다.');
    }
  }

  function formatSummary(profile = {}) {
    const resolution = String(profile.resolution || '1920x1080');
    const [, height] = resolution.split('x');
    const label = height ? `${height}p` : resolution;
    return `${label} · ${profile.fps || 60} FPS · ${profile.bitrate || 10} Mbps`;
  }

  RP4.profile = {
    BUILTIN_PRESETS,
    get,
    getPersistable,
    applyToForm,
    getPresetByKey,
    setActivePreset,
    markChanged,
    applyPreset,
    applyLiveGains,
    scheduleProfileSave,
    createCustomPreset,
    updateCustomPreset,
    deleteCustomPreset,
    formatSummary
  };
}(window.RP4));
