'use strict';

/*
 * Bootstrap, element wiring and shared UI updates.
 */
(function initApp(RP4) {
  const { state, els, util } = RP4;

  function cacheElements() {
    Object.assign(els, {
      previewStage: RP4.$('#previewStage'),
      previewVideo: RP4.$('#previewVideo'),
      previewPlaceholder: RP4.$('#previewPlaceholder'),
      previewMeta: RP4.$('#previewMeta'),
      recordingPill: RP4.$('#recordingPill'),
      recordingTimer: RP4.$('#recordingTimer'),
      progressBar: RP4.$('#progressBar'),
      progressFill: RP4.$('#progressFill'),
      progressLabel: RP4.$('#progressLabel'),

      recordButton: RP4.$('#recordButton'),
      pauseButton: RP4.$('#pauseButton'),
      screenshotButton: RP4.$('#screenshotButton'),
      clipModeButton: RP4.$('#clipModeButton'),
      clipSaveButton: RP4.$('#clipSaveButton'),

      modeGrid: RP4.$('#modeGrid'),
      presetBody: RP4.$('#presetBody'),
      customPresetList: RP4.$('#customPresetList'),

      formatSelect: RP4.$('#formatSelect'),
      resolutionSelect: RP4.$('#resolutionSelect'),
      fpsSelect: RP4.$('#fpsSelect'),
      bitrateSelect: RP4.$('#bitrateSelect'),
      encoderPresetSelect: RP4.$('#encoderPresetSelect'),
      audioBitrateSelect: RP4.$('#audioBitrateSelect'),
      optimizeMp4Toggle: RP4.$('#optimizeMp4Toggle'),
      clipBufferInput: RP4.$('#clipBufferInput'),
      pipelineNote: RP4.$('#pipelineNote'),
      screenshotFormatSelect: RP4.$('#screenshotFormatSelect'),
      screenshotQualitySelect: RP4.$('#screenshotQualitySelect'),
      screenshotQualityNote: RP4.$('#screenshotQualityNote'),
      languageSelect: RP4.$('#languageSelect'),

      clipDurationInput: RP4.$('#clipDurationInput'),
      clipDurationUp: RP4.$('#clipDurationUp'),
      clipDurationDown: RP4.$('#clipDurationDown'),

      micToggle: RP4.$('#micToggle'),
      systemAudioToggle: RP4.$('#systemAudioToggle'),
      micVolume: RP4.$('#micVolume'),
      systemVolume: RP4.$('#systemVolume'),
      micVolumeLabel: RP4.$('#micVolumeLabel'),
      systemVolumeLabel: RP4.$('#systemVolumeLabel'),
      createPresetButton: RP4.$('#createPresetButton'),

      hotkeyGrid: RP4.$('#hotkeyGrid'),
      resetHotkeysButton: RP4.$('#resetHotkeysButton'),

      sourceModal: RP4.$('#sourceModal'),
      sourceGrid: RP4.$('#sourceGrid'),
      sourceModalTitle: RP4.$('#sourceModalTitle'),
      closeSourceModal: RP4.$('#closeSourceModal'),

      settingsModal: RP4.$('#settingsModal'),
      settingsModalTitle: RP4.$('#settingsModalTitle'),
      closeSettingsModal: RP4.$('#closeSettingsModal'),

      recordingList: RP4.$('#recordingList'),
      refreshFilesButton: RP4.$('#refreshFilesButton'),
      openFolderButton: RP4.$('#openFolderButton'),
      chooseFolderButton: RP4.$('#chooseFolderButton'),

      toast: RP4.$('#toast'),
      minimizeButton: RP4.$('#minimizeButton'),
      maximizeButton: RP4.$('#maximizeButton'),
      closeButton: RP4.$('#closeButton'),
      versionLabel: RP4.$('#versionLabel')
    });

    // Fail loudly during development if the markup and the renderer drift apart, instead
    // of throwing halfway through wiring and leaving a half-initialised UI.
    const missing = Object.entries(els)
      .filter(([, node]) => !node)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(`UI 요소를 찾을 수 없습니다: ${missing.join(', ')}`);
    }
  }

  function getSourceTitle(source) {
    if (!source) return RP4.i18n.translate('소스 없음');
    if (source.type === 'screen') {
      const index = source.display?.index
        || getScreenSources().findIndex((item) => item.id === source.id) + 1;
      return RP4.i18n.translate(
        source.display?.primary ? `모니터 ${index} (주 화면)` : `모니터 ${index}`
      );
    }
    return source.name || RP4.i18n.translate('창');
  }

  function getModeLabel(mode) {
    if (mode === 'window') return RP4.i18n.translate('창 지정');
    if (mode === 'monitor') return RP4.i18n.translate('특정 모니터');
    if (mode === 'area') return RP4.i18n.translate('영역 녹화');
    return RP4.i18n.translate('전체 화면');
  }

  function getScreenSources() {
    return state.sources.filter((source) => source.type === 'screen');
  }

  function getSourcesForMode(mode) {
    if (mode === 'window') return state.sources.filter((source) => source.type === 'window');
    return getScreenSources();
  }

  function setActiveMode(mode) {
    for (const button of RP4.$$('.mode-card')) {
      button.classList.toggle('active', button.dataset.mode === mode);
    }
  }

  /** Shows the resolution actually being produced, not just the one requested. */
  function updatePreviewMeta(output) {
    const profile = state.recording?.profile || state.clip?.profile || RP4.profile.get();
    const active = output
      || state.recording?.output
      || state.clip?.output
      || state.preview?.output;
    const width = active?.width || profile.width;
    const height = active?.height || profile.height;
    const source = getSourceTitle(state.selectedSource);

    els.previewMeta.textContent =
      `${width} x ${height} | ${profile.fps} FPS | ${profile.format.toUpperCase()} | ${source}`;

    updatePipelineNote();
  }

  /** Explains how the file will be finished so the save path is never a surprise. */
  function updatePipelineNote() {
    if (!els.pipelineNote) return;
    const profile = state.recording?.profile || state.clip?.profile || RP4.profile.get();
    const codec = RP4.capture.pickRecorderMime(profile.format);
    els.pipelineNote.classList.remove('hidden');

    if (!codec) {
      els.pipelineNote.textContent = '지원되는 녹화 코덱을 찾지 못했습니다.';
      return;
    }
    if (codec.finish === 'direct') {
      els.pipelineNote.textContent = '';
      els.pipelineNote.classList.add('hidden');
      return;
    }
    if (codec.finish === 'stream-copy') {
      els.pipelineNote.textContent = 'H.264로 기록한 뒤 빠른 컨테이너 변환만 수행합니다.';
      return;
    }
    els.pipelineNote.textContent =
      '이 시스템은 H.264 직접 기록을 지원하지 않아 저장 시 변환이 필요합니다.';
  }

  function updateVolumeLabels() {
    els.micVolumeLabel.textContent = `${els.micVolume.value}%`;
    els.systemVolumeLabel.textContent = `${els.systemVolume.value}%`;
  }

  function updateRecordingUi() {
    const recording = state.isRecording;
    const clipActive = Boolean(state.clip);
    const transitioning = ['starting-recording', 'stopping-recording', 'starting-clip', 'stopping-clip']
      .includes(state.captureLifecycle);

    els.recordButton.classList.toggle('recording', recording);
    els.recordButton.querySelector('span').textContent = recording ? 'STOP' : 'REC';
    els.recordButton.disabled = clipActive || transitioning;

    els.pauseButton.disabled = !recording;
    els.pauseButton.querySelector('span').textContent = state.isPaused ? '재개' : '일시정지';

    els.recordingPill.classList.toggle('hidden', !recording && !clipActive);
    els.recordingPill.classList.toggle('paused', state.isPaused);
    updateProfileControls();
    void window.rp4.reportCaptureState({
      recordingActive: Boolean(state.recording),
      clipActive: Boolean(state.clip),
      clipSaving: Boolean(state.clipSaving)
    }).catch(() => {});
  }

  function updateProfileControls() {
    const locked = RP4.lifecycle.isBusy();
    const fixedControls = [
      els.formatSelect,
      els.resolutionSelect,
      els.fpsSelect,
      els.bitrateSelect,
      els.encoderPresetSelect,
      els.audioBitrateSelect,
      els.micToggle,
      els.systemAudioToggle,
      els.clipDurationInput,
      els.clipDurationUp,
      els.clipDurationDown,
      els.createPresetButton
    ];
    for (const control of fixedControls) control.disabled = locked;
    for (const control of els.presetBody.querySelectorAll('button')) control.disabled = locked;
  }

  function updateClipUi() {
    const active = Boolean(state.clip);
    const transitioning = ['starting-recording', 'stopping-recording', 'starting-clip', 'stopping-clip']
      .includes(state.captureLifecycle);
    els.clipModeButton.classList.toggle('active', active);
    els.clipModeButton.querySelector('span').textContent =
      active ? '클립 녹화 모드 중지' : '클립 녹화 모드 시작';
    els.clipModeButton.disabled = transitioning || state.captureLifecycle === 'saving-clip';
    els.clipSaveButton.disabled = !active || state.clipSaving || transitioning;
    els.clipSaveButton.querySelector('span').textContent =
      state.clipSaving ? '클립 저장 중' : '클립 저장';
    updateRecordingUi();
  }

  function startTimer() {
    stopTimer();
    updateTimer();
    state.timerId = window.setInterval(updateTimer, 250);
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
    els.recordingTimer.textContent = '00:00:00';
  }

  function updateTimer() {
    let elapsed = 0;
    if (state.isRecording) {
      elapsed = RP4.recorder.elapsedMs();
    } else if (state.clip) {
      const buffer = RP4.clips.bufferStatus();
      if (buffer) {
        els.recordingTimer.textContent =
          `${util.formatDuration(buffer.availableMs)} / ${util.formatDuration(buffer.targetMs)}`;
        els.recordingTimer.title = buffer.limitedByCapacity
          ? '메모리 한도로 인해 현재 확보 길이가 목표보다 짧을 수 있습니다.'
          : '현재 확보 길이 / 목표 클립 길이';
        return;
      }
      elapsed = 0;
    }
    els.recordingTimer.title = '';
    els.recordingTimer.textContent = util.formatDuration(elapsed);
  }

  function setProgress(ratio, label) {
    if (ratio == null) {
      els.progressBar.classList.add('hidden');
      return;
    }
    els.progressBar.classList.remove('hidden');
    els.progressFill.style.width = `${Math.round(util.clamp(ratio, 0, 1) * 100)}%`;
    els.progressLabel.textContent = label || '';
  }

  function applyAppSettings(settings = {}) {
    state.appSettings = {
      language: settings.language === 'en' ? 'en' : 'ko',
      selectedPreset: Object.hasOwn(settings, 'selectedPreset') ? settings.selectedPreset : 'normal',
      customPresets: Array.isArray(settings.customPresets) ? settings.customPresets : [],
      profile: settings.profile || null,
      recordingsDir: settings.recordingsDir || state.appInfo?.recordingsDir || '',
      optimizeMp4: settings.optimizeMp4 !== false,
      screenshotFormat: ['png', 'jpeg', 'webp'].includes(settings.screenshotFormat)
        ? settings.screenshotFormat
        : 'png',
      screenshotQuality: util.clamp(Number(settings.screenshotQuality) || 100, 10, 100),
      clipBufferLimitMb: Number(settings.clipBufferLimitMb) || 256,
      maxCustomPresets: Number(settings.maxCustomPresets) || 48
    };
    state.selectedPreset = state.appSettings.selectedPreset;

    els.languageSelect.value = state.appSettings.language;
    RP4.i18n.setLanguage(state.appSettings.language);
    els.optimizeMp4Toggle.checked = state.appSettings.optimizeMp4;
    els.clipBufferInput.value = String(state.appSettings.clipBufferLimitMb);
    els.screenshotFormatSelect.value = state.appSettings.screenshotFormat;
    els.screenshotQualitySelect.value = String(state.appSettings.screenshotQuality);
    updateScreenshotQualityUi();

    renderCustomPresets();
    updateRecordingFolderUi();
  }

  function updateRecordingFolderUi() {
    const dir = state.appSettings.recordingsDir || state.appInfo?.recordingsDir || '';
    els.chooseFolderButton.title = dir ? `현재 경로: ${dir}` : '녹화 파일 저장 경로 지정';
  }

  function createCustomPresetItem(preset) {
    const row = document.createElement('div');
    row.className = 'custom-preset-row';

    const card = document.createElement('button');
    card.className = 'preset-card';
    card.type = 'button';
    card.dataset.presetKey = `custom:${preset.id}`;

    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = preset.name;
    const summary = document.createElement('small');
    summary.textContent = RP4.profile.formatSummary(preset.profile);
    text.append(title, summary);
    card.append(text);

    const actions = document.createElement('div');
    actions.className = 'custom-preset-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '수정';
    edit.dataset.presetEdit = preset.id;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '삭제';
    remove.dataset.presetDelete = preset.id;
    actions.append(edit, remove);

    row.append(card, actions);
    return row;
  }

  function renderCustomPresets() {
    els.customPresetList.replaceChildren();

    if (!state.appSettings.customPresets.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state compact';
      empty.textContent = '생성한 프리셋이 없습니다.\n설정에서 프리셋을 만들어 주세요.';
      els.customPresetList.append(empty);
      return;
    }

    for (const preset of state.appSettings.customPresets) {
      els.customPresetList.append(createCustomPresetItem(preset));
    }
    RP4.profile.setActivePreset(state.selectedPreset);
  }

  async function loadAppSettings() {
    try {
      const settings = await window.rp4.getAppSettings();
      applyAppSettings(settings);

      // Restore the saved working profile, falling back to the selected preset.
      if (settings.profile) {
        RP4.profile.applyToForm(settings.profile);
        if (RP4.profile.matchesPreset(settings.profile, state.appSettings.selectedPreset)) {
          RP4.profile.setActivePreset(state.appSettings.selectedPreset);
        } else {
          RP4.profile.setActivePreset(null);
          if (state.appSettings.selectedPreset != null) {
            const corrected = await window.rp4.saveProfileState({
              selectedPreset: null,
              profile: settings.profile
            });
            applyAppSettings(corrected);
            RP4.profile.setActivePreset(null);
          }
        }
      } else {
        await RP4.profile.applyPreset(state.appSettings.selectedPreset || 'normal', { persist: false });
      }
    } catch (error) {
      console.error(error);
      RP4.profile.setActivePreset('normal');
      RP4.ui.showToast('앱 설정을 불러오지 못했습니다.');
    }
  }

  async function refreshSources() {
    try {
      state.sources = await window.rp4.listSources();
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('캡처 소스를 불러오지 못했습니다.');
    }
  }

  async function selectDefaultScreen() {
    const screens = getScreenSources();
    const primary = screens.find((source) => source.display?.primary) || screens[0];
    if (!primary) {
      RP4.ui.setStatus('소스 없음', '캡처 가능한 화면을 찾지 못했습니다.', 'warn');
      return;
    }
    await chooseSource(primary, 'screen', { allowBusy: true });
  }

  async function chooseSource(source, mode = state.selectedMode, { generation = null, allowBusy = false } = {}) {
    if ((generation != null && generation !== state.sourceSelectionGeneration)
      || (!allowBusy && RP4.lifecycle.isBusy())) return false;
    state.selectedSource = source;
    state.selectedMode = mode;
    if (mode !== 'area') state.hasAreaSelection = false;
    setActiveMode(mode);
    updatePreviewMeta();
    if (!RP4.lifecycle.isBusy()) {
      await RP4.recorder.startPreview();
    }
    return true;
  }

  async function setMode(mode) {
    if (state.sourceSelectionPending) {
      RP4.ui.showToast('진행 중인 캡처 소스 선택을 먼저 완료해 주세요.');
      return;
    }
    if (RP4.lifecycle.isBusy()) {
      RP4.ui.showToast('녹화 중에는 캡처 모드를 바꿀 수 없습니다.');
      return;
    }

    const generation = ++state.sourceSelectionGeneration;

    if (mode === 'area') {
      await chooseDesktopArea(generation);
      return;
    }

    if (mode === 'screen') {
      state.sourceSelectionPending = true;
      try {
        await refreshSources();
        if (generation !== state.sourceSelectionGeneration || RP4.lifecycle.isBusy()) return;
        const screens = getScreenSources();
        const source = screens.find((item) => item.display?.primary) || screens[0];
        if (source) await chooseSource(source, mode, { generation });
      } finally {
        state.sourceSelectionPending = false;
      }
      return;
    }

    await openSourceModal(mode, generation);
  }

  async function chooseDesktopArea(generation) {
    if (state.sourceSelectionPending) return;
    state.sourceSelectionPending = true;
    try {
      await performChooseDesktopArea(generation);
    } finally {
      state.sourceSelectionPending = false;
    }
  }

  async function performChooseDesktopArea(generation) {
    const previousMode = state.selectedMode;
    setActiveMode('area');
    RP4.ui.setStatus('영역 선택', '실제 화면에서 녹화할 영역을 드래그하세요.', 'warn');

    let result = null;
    try {
      result = await window.rp4.selectArea();
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('영역 선택 화면을 열지 못했습니다.');
    }

    if (generation !== state.sourceSelectionGeneration || RP4.lifecycle.isBusy()) return;

    if (!result?.selection) {
      setActiveMode(previousMode);
      RP4.ui.setStatus('준비 완료', '녹화 준비가\n완료되었습니다.', 'ready');
      return;
    }

    await refreshSources();
    if (generation !== state.sourceSelectionGeneration || RP4.lifecycle.isBusy()) return;
    const screens = getScreenSources();
    const source = screens.find((item) => String(item.displayId) === String(result.displayId))
      || screens.find((item) => item.display?.primary)
      || screens[0];

    if (!source) {
      setActiveMode(previousMode);
      RP4.ui.setStatus('소스 없음', '영역 녹화에 사용할 화면을 찾지 못했습니다.', 'warn');
      RP4.ui.showToast('영역 녹화에 사용할 화면을 찾지 못했습니다.');
      return;
    }

    state.areaSelection = result.selection;
    state.hasAreaSelection = true;
    await chooseSource(source, 'area', { generation });

    const size = result.absolute;
    RP4.ui.showToast(`영역을 지정했습니다: ${size.width} x ${size.height}`);
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
      if (source.id === state.selectedSource?.id) card.classList.add('active');

      if (source.thumbnail) {
        const img = document.createElement('img');
        img.src = source.thumbnail;
        img.alt = '';
        card.append(img);
      } else {
        const fallback = document.createElement('div');
        fallback.className = 'source-thumb-fallback';
        fallback.innerHTML = RP4.files.VIDEO_ICON;
        card.append(fallback);
      }

      if (source.requiresRestore) {
        const stateBadge = document.createElement('span');
        stateBadge.className = 'source-state-badge';
        stateBadge.textContent = '최소화됨';
        card.append(stateBadge);
      }

      const title = document.createElement('strong');
      title.textContent = getSourceTitle(source);
      card.append(title);
      els.sourceGrid.append(card);
    }
  }

  async function openSourceModal(mode, generation = ++state.sourceSelectionGeneration) {
    if (RP4.lifecycle.isBusy()) {
      RP4.ui.showToast('녹화 중에는 소스를 바꿀 수 없습니다.');
      return;
    }

    state.sourceSelectionPending = true;
    state.modalMode = mode;
    state.modalGeneration = generation;
    await refreshSources();
    if (generation !== state.sourceSelectionGeneration || RP4.lifecycle.isBusy()) {
      state.sourceSelectionPending = false;
      return;
    }

    els.sourceModalTitle.textContent = mode === 'window'
      ? '창 선택'
      : mode === 'area' ? '영역 녹화 화면 선택' : '모니터 선택';

    renderSourceCards(mode);
    els.sourceModal.classList.remove('hidden');
  }

  function closeSourceModal() {
    els.sourceModal.classList.add('hidden');
    state.sourceSelectionPending = false;
  }

  function setSettingsTab(type = 'record') {
    RP4.$('#recordSettingsBody').classList.toggle('hidden', type !== 'record');
    RP4.$('#screenshotSettingsBody').classList.toggle('hidden', type !== 'screenshot');
    RP4.$('#hotkeySettingsBody').classList.toggle('hidden', type !== 'hotkeys');
    for (const button of RP4.$$('[data-settings-tab]')) {
      const active = button.dataset.settingsTab === type;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    if (type === 'hotkeys') RP4.hotkeys.render();
  }

  function openSettingsModal(type = 'record') {
    els.settingsModalTitle.textContent = '설정';
    setSettingsTab(type);
    els.settingsModal.classList.remove('hidden');

    for (const button of RP4.$$('[data-settings-popup]')) {
      button.setAttribute('aria-expanded', String(button.dataset.settingsPopup === type));
    }
  }

  function updateScreenshotQualityUi() {
    const lossless = els.screenshotFormatSelect.value === 'png';
    els.screenshotQualitySelect.disabled = lossless;
    els.screenshotQualityNote.textContent = lossless
      ? 'PNG는 원본 해상도를 무손실로 저장하므로 품질이 최고로 고정됩니다.'
      : 'JPG와 WebP는 선택한 품질이 높을수록 파일 용량도 커집니다.';
  }

  async function saveScreenshotSettings() {
    const screenshotFormat = els.screenshotFormatSelect.value;
    const screenshotQuality = util.clamp(Number(els.screenshotQualitySelect.value) || 100, 10, 100);
    state.appSettings.screenshotFormat = screenshotFormat;
    state.appSettings.screenshotQuality = screenshotQuality;
    try {
      await window.rp4.setOptions({ screenshotFormat, screenshotQuality });
    } catch {
      RP4.ui.showToast('스크린샷 설정을 저장하지 못했습니다.');
    }
  }

  function closeSettingsModal() {
    state.editingHotkey = null;
    els.settingsModal.classList.add('hidden');
    for (const button of RP4.$$('[data-settings-popup]')) {
      button.setAttribute('aria-expanded', 'false');
    }
    RP4.hotkeys.render();
  }

  async function chooseRecordingsFolder() {
    if (RP4.lifecycle.isBusy()) {
      RP4.ui.showToast('녹화 중에는 저장 경로를 바꿀 수 없습니다.');
      return;
    }

    try {
      const result = await window.rp4.chooseRecordingsFolder();
      if (result?.canceled) return;
      if (result?.failed) {
        RP4.ui.showToast(result.error || '저장 경로를 변경하지 못했습니다.');
        return;
      }

      const captureStartedWhileDialogClosed = RP4.lifecycle.isBusy();
      state.appSettings.recordingsDir = result.recordingsDir;
      if (state.appInfo) state.appInfo.recordingsDir = result.recordingsDir;
      updateRecordingFolderUi();
      if (!captureStartedWhileDialogClosed) await RP4.files.render();
      RP4.ui.showToast(`저장 경로를 변경했습니다: ${result.recordingsDir}`);
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('저장 경로를 변경하지 못했습니다.');
    }
  }

  function stepClipDuration(direction) {
    const current = RP4.profile.get().clipDurationSeconds;
    els.clipDurationInput.value = String(util.clamp(current + direction, 1, 7200));
    RP4.profile.markChanged();
    RP4.clips.pruneActiveBuffer();
  }

  async function handlePresetClick(event) {
    const editButton = event.target.closest('[data-preset-edit]');
    if (editButton) {
      await RP4.profile.updateCustomPreset(editButton.dataset.presetEdit);
      return;
    }

    const deleteButton = event.target.closest('[data-preset-delete]');
    if (deleteButton) {
      await RP4.profile.deleteCustomPreset(deleteButton.dataset.presetDelete);
      return;
    }

    const card = event.target.closest('.preset-card');
    if (!card || !els.presetBody.contains(card)) return;
    await RP4.profile.applyPreset(card.dataset.presetKey || card.dataset.preset);
  }

  function bindEvents() {
    els.recordButton.addEventListener('click', () => void RP4.recorder.toggleRecording());
    els.pauseButton.addEventListener('click', () => RP4.recorder.togglePause());
    els.screenshotButton.addEventListener('click', () => void RP4.files.takeScreenshot());
    els.clipModeButton.addEventListener('click', () => void RP4.clips.toggleClipMode());
    els.clipSaveButton.addEventListener('click', () => void RP4.clips.saveClip());

    els.refreshFilesButton.addEventListener('click', () => void RP4.files.render());
    els.openFolderButton.addEventListener('click', () => void window.rp4.openRecordingsFolder());
    els.chooseFolderButton.addEventListener('click', () => void chooseRecordingsFolder());
    els.recordingList.addEventListener('wheel', (event) => {
      if (els.recordingList.scrollWidth <= els.recordingList.clientWidth) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      event.preventDefault();
      els.recordingList.scrollLeft += delta;
    }, { passive: false });
    els.createPresetButton.addEventListener('click', () => void RP4.profile.createCustomPreset());

    els.resetHotkeysButton.addEventListener('click', () => void RP4.hotkeys.reset());
    els.hotkeyGrid.addEventListener('click', (event) => {
      const button = event.target.closest('.hotkey-input');
      if (button) RP4.hotkeys.startCapture(button.dataset.hotkey);
    });

    document.addEventListener('keydown', (event) => void RP4.hotkeys.capture(event));
    document.addEventListener('keydown', (event) => void RP4.hotkeys.handleLocal(event));
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.key !== 'Escape' || state.editingHotkey) return;
      if (!els.settingsModal.classList.contains('hidden')) closeSettingsModal();
      else if (!els.sourceModal.classList.contains('hidden')) closeSourceModal();
    });

    els.modeGrid.addEventListener('click', (event) => {
      const button = event.target.closest('.mode-card');
      if (button) void setMode(button.dataset.mode);
    });

    els.closeSourceModal.addEventListener('click', closeSourceModal);
    els.sourceModal.addEventListener('click', (event) => {
      if (event.target === els.sourceModal) closeSourceModal();
    });
    els.closeSettingsModal.addEventListener('click', closeSettingsModal);
    els.settingsModal.addEventListener('click', (event) => {
      if (event.target === els.settingsModal) closeSettingsModal();
    });
    els.settingsModal.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-settings-tab]');
      if (tab) setSettingsTab(tab.dataset.settingsTab);
    });

    els.sourceGrid.addEventListener('click', async (event) => {
      const card = event.target.closest('.source-card');
      if (!card) return;
      let source = state.sources.find((item) => item.id === card.dataset.sourceId);
      if (!source) return;
      const generation = state.modalGeneration;
      if (generation !== state.sourceSelectionGeneration || RP4.lifecycle.isBusy()) return;
      if (source.requiresRestore) {
        card.disabled = true;
        RP4.ui.showToast('최소화되었거나 숨겨진 창을 복원하고 있습니다.');
        const prepared = await window.rp4.prepareWindowSource(source.id).catch(() => null);
        card.disabled = false;
        if (!prepared) {
          RP4.ui.showToast('이 창을 복원하거나 캡처할 수 없습니다.');
          return;
        }
        state.sources = state.sources.map((item) => item.id === source.id ? prepared : item);
        source = prepared;
      }
      closeSourceModal();
      await chooseSource(source, state.modalMode, { generation });
    });

    // Only resolution and frame rate change the capture itself. Bitrate, container and
    // audio quality apply at record time, so they no longer tear down the preview.
    for (const element of [els.resolutionSelect, els.fpsSelect]) {
      element.addEventListener('change', async () => {
        RP4.profile.markChanged();
        await RP4.recorder.restartPreview();
      });
    }
    for (const element of [els.formatSelect, els.bitrateSelect, els.encoderPresetSelect, els.audioBitrateSelect]) {
      element.addEventListener('change', () => RP4.profile.markChanged());
    }

    els.clipDurationInput.addEventListener('input', () => {
      RP4.profile.markChanged();
      RP4.clips.pruneActiveBuffer();
    });
    els.clipDurationInput.addEventListener('blur', () => {
      els.clipDurationInput.value = String(RP4.profile.get().clipDurationSeconds);
    });
    els.clipDurationUp.addEventListener('click', () => stepClipDuration(1));
    els.clipDurationDown.addEventListener('click', () => stepClipDuration(-1));

    els.micToggle.addEventListener('change', () => RP4.profile.markChanged());
    els.systemAudioToggle.addEventListener('change', () => RP4.profile.markChanged());
    els.micVolume.addEventListener('input', () => {
      RP4.profile.markChanged({ allowWhileActive: true });
      updateVolumeLabels();
    });
    els.systemVolume.addEventListener('input', () => {
      RP4.profile.markChanged({ allowWhileActive: true });
      updateVolumeLabels();
    });

    els.optimizeMp4Toggle.addEventListener('change', async () => {
      state.appSettings.optimizeMp4 = els.optimizeMp4Toggle.checked;
      try {
        await window.rp4.setOptions({ optimizeMp4: els.optimizeMp4Toggle.checked });
      } catch {
        RP4.ui.showToast('설정을 저장하지 못했습니다.');
      }
    });

    els.clipBufferInput.addEventListener('change', async () => {
      const value = util.clamp(Number(els.clipBufferInput.value) || 256, 64, 512);
      els.clipBufferInput.value = String(value);
      state.appSettings.clipBufferLimitMb = value;
      try {
        await window.rp4.setOptions({ clipBufferLimitMb: value });
      } catch {
        RP4.ui.showToast('설정을 저장하지 못했습니다.');
      }
    });

    els.presetBody.addEventListener('click', (event) => void handlePresetClick(event));

    for (const button of RP4.$$('.section-toggle')) {
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
    }

    els.minimizeButton.addEventListener('click', () => void window.rp4.window.minimize());
    els.maximizeButton.addEventListener('click', () => void window.rp4.window.maximizeToggle());
    els.closeButton.addEventListener('click', () => void window.rp4.window.close());

    window.rp4.onHotkey((action) => void RP4.hotkeys.dispatch(action));

    window.rp4.onNotice((notice) => {
      RP4.ui.showToast(notice.message, { durationMs: 6000 });
    });

    window.rp4.onConvertProgress(({ phase, ratio }) => {
      util.reportShutdownProgress({ phase, ratio: Number(ratio) || 0 });
      const label = phase === 'transcode' ? '변환 중' : '컨테이너 정리 중';
      setProgress(ratio, `${label} ${Math.round(ratio * 100)}%`);
      if (ratio >= 1) window.setTimeout(() => setProgress(null), 800);
    });

    window.rp4.onOptimizeState(({ state: phase }) => {
      // Optimization runs after the file is already saved and listed, so it only ever
      // reports; it never blocks.
      if (phase === 'start') setProgress(0.05, 'MP4 최적화 중 (백그라운드)');
      else {
        setProgress(null);
        if (phase === 'failed') RP4.ui.showToast('MP4 최적화에 실패해 원본 파일을 유지했습니다.');
        if (phase === 'skipped-low-space') RP4.ui.showToast('저장 공간이 부족해 MP4 최적화를 건너뛰었습니다.');
      }
    });

    els.languageSelect.addEventListener('change', async () => {
      const language = els.languageSelect.value === 'en' ? 'en' : 'ko';
      state.appSettings.language = language;
      RP4.i18n.setLanguage(language);
      updatePipelineNote();
      updateRecordingUi();
      updateClipUi();
      renderCustomPresets();
      RP4.hotkeys.render();
      void RP4.files.render();
      try {
        await window.rp4.setOptions({ language });
      } catch {
        RP4.ui.showToast('설정을 저장하지 못했습니다.');
      }
    });

    window.rp4.onVerifyState(({ state: phase }) => {
      if (phase === 'start') setProgress(0.1, '저장 파일 검증 중');
      else {
        setProgress(null);
        void RP4.files.render();
        if (phase === 'failed') RP4.ui.showToast('저장 파일 검증에 실패했습니다. 파일을 부분 저장으로 표시합니다.');
      }
    });

    window.rp4.onDiskFull(() => {
      RP4.ui.showToast('저장 공간이 거의 없습니다. 녹화를 중지합니다.');
      void RP4.recorder.stopRecording();
    });

    window.rp4.onFinalizeRecordings(async ({ requestId, clipShutdownMode = 'discard' } = {}) => {
      state.shutdownRequestId = requestId;
      state.shuttingDown = true;
      document.body.classList.add('shutdown-pending');
      window.rp4.reportFinalizeAccepted(requestId);
      let heartbeatSequence = 0;
      util.reportShutdownProgress({ phase: 'shutdown-finalizing', sequence: heartbeatSequence });
      const heartbeat = window.setInterval(() => {
        heartbeatSequence += 1;
        util.reportShutdownProgress({ phase: 'shutdown-finalizing', sequence: heartbeatSequence });
      }, 5000);
      try {
        if (clipShutdownMode !== 'discard') {
          const clipResult = await RP4.clips.prepareForShutdown(clipShutdownMode);
          if (!clipResult?.ok) {
            window.rp4.reportFinalizeFailed(requestId, clipResult?.error);
            state.shuttingDown = false;
            document.body.classList.remove('shutdown-pending');
            RP4.app.updateClipUi();
            return;
          }
        }
        RP4.lifecycle.prepareShutdown();
        const finalized = await Promise.allSettled([
          RP4.recorder.finalizeForShutdown(),
          RP4.clips.finalizeForShutdown(),
          RP4.files.finalizeForShutdown(),
          RP4.profile.flushSave()
        ]);
        const rejected = finalized.find((result) => result.status === 'rejected');
        if (rejected) {
          throw rejected.reason || new Error('종료 전 저장 작업을 완료하지 못했습니다.');
        }
        window.rp4.reportFinalizeComplete(requestId, { ok: true });
      } catch (error) {
        window.rp4.reportFinalizeFailed(requestId, error?.message || error);
        state.shuttingDown = false;
        document.body.classList.remove('shutdown-pending');
        RP4.app.updateClipUi();
      } finally {
        window.clearInterval(heartbeat);
        state.shutdownRequestId = null;
      }
    });

    els.screenshotFormatSelect.addEventListener('change', () => {
      updateScreenshotQualityUi();
      void saveScreenshotSettings();
    });
    els.screenshotQualitySelect.addEventListener('change', () => void saveScreenshotSettings());
  }

  /**
   * Exercises the real startup path, not just "a window opened": source enumeration, an
   * actual desktop capture stream, and the window-crop helper.
   */
  async function runSmokeChecks() {
    const profile = RP4.profile.get();
    const codec = RP4.capture.pickRecorderMime(profile.format);
    const report = {
      recordingsDir: state.appInfo.recordingsDir,
      ffmpegAvailable: state.appInfo.ffmpegAvailable,
      mimeType: codec?.mimeType || null,
      finish: codec?.finish || null,
      zeroCopyCrop: RP4.capture.supportsZeroCopyCrop()
    };

    try {
      await RP4.files.render();
      await refreshSources();
      report.screenSources = getScreenSources().length;
      report.windowSources = state.sources.length - report.screenSources;

      // Open a real capture stream so a broken capture path fails the check.
      await selectDefaultScreen();
      report.previewWidth = state.preview?.output?.width || 0;
      report.previewHeight = state.preview?.output?.height || 0;

      // Exercise the persistent window-crop helper when a window is available. Not fatal:
      // every candidate window may legitimately be minimized.
      const windowSource = state.sources.find((source) => source.type === 'window');
      if (windowSource) {
        const crop = await window.rp4.getWindowClientCrop(windowSource.id);
        report.windowCrop = crop ? `${crop.width}x${crop.height}` : 'unavailable';
      }

      state.sourceSelectionPending = true;
      await RP4.recorder.toggleRecording();
      await RP4.clips.toggleClipMode();
      await RP4.files.takeScreenshot();
      report.sourceSelectionGuard = !state.recording && !state.clip && !state.screenshotPromise;
      state.sourceSelectionPending = false;

      report.ok = Boolean(codec)
        && Boolean(state.appInfo.recordingsDir)
        && report.screenSources > 0
        && report.previewWidth > 0
        && report.previewHeight > 0
        && report.sourceSelectionGuard;
    } catch (error) {
      state.sourceSelectionPending = false;
      report.ok = false;
      report.error = String(error?.message || error);
    }

    await window.rp4.reportSmoke(report);
  }

  async function init() {
    try {
      cacheElements();
      bindEvents();
    } catch (error) {
      console.error(error);
      document.body.innerHTML =
        '<div style="padding:32px;color:#fff;font-family:sans-serif">'
        + 'RP4 화면을 초기화할 수 없습니다.</div>';
      return;
    }

    try {
      state.appInfo = await window.rp4.appInfo();
      els.versionLabel.textContent = `v${state.appInfo.version}`;
      await loadAppSettings();
      await RP4.hotkeys.load();
      updateVolumeLabels();
      updateRecordingUi();
      updateClipUi();
      updatePreviewMeta();
      stopTimer();

      if (state.appInfo.isSmoke) {
        await runSmokeChecks();
        return;
      }

      await refreshSources();
      await selectDefaultScreen();
      await RP4.files.render();
    } catch (error) {
      console.error(error);
      RP4.ui.setStatus('초기화 실패', '앱을 초기화하지 못했습니다.', 'warn');
      RP4.ui.showToast(`초기화 오류: ${error?.message || error}`);
      if (state.appInfo?.isSmoke) {
        await window.rp4.reportSmoke({ ok: false, error: String(error?.message || error) });
      }
    }
  }

  RP4.app = {
    init,
    applyAppSettings,
    updatePreviewMeta,
    updatePipelineNote,
    updateVolumeLabels,
    updateRecordingUi,
    updateClipUi,
    startTimer,
    stopTimer,
    updateTimer,
    setProgress,
    getSourceTitle,
    getModeLabel,
    selectDefaultScreen,
    refreshSources,
    chooseSource,
    setMode,
    renderCustomPresets
  };

  window.addEventListener('DOMContentLoaded', () => void init());
}(window.RP4));
