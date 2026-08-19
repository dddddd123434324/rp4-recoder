'use strict';

/*
 * Saved recordings list and screenshots.
 */
(function initFiles(RP4) {
  const { state, els, util } = RP4;

  const VIDEO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="13" rx="1.6"/><path d="M8 21h8M12 18v3"/></svg>';
  const thumbnailRecordings = new WeakMap();
  let observedRecordingList = null;
  const recordingListResizeObserver = new ResizeObserver(() => layoutRecentFiles());
  const thumbnailObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbnailObserver.unobserve(entry.target);
      const recording = thumbnailRecordings.get(entry.target);
      if (!recording) continue;
      void window.rp4.getRecordingThumbnail(recording.filePath).then((dataUrl) => {
        if (!dataUrl || !entry.target.isConnected) return;
        const image = document.createElement('img');
        image.src = dataUrl;
        image.alt = '';
        image.addEventListener('load', () => entry.target.replaceChildren(image), { once: true });
      }).catch(() => {});
    }
  }, { rootMargin: '96px 0px' });

  /**
   * CSS flows the horizontally scrolling grid by column. Reorder items so each visible
   * page fills its top row left-to-right before moving down, avoiding a left-heavy stack
   * on tall windows while keeping overflow on the horizontal axis.
   */
  function layoutRecentFiles() {
    const list = els.recordingList;
    if (!list || list.clientWidth <= 0 || list.clientHeight <= 0) return;
    const items = [...list.querySelectorAll('.recording-item')];
    if (!items.length) return;

    const computed = getComputedStyle(list);
    const columnGap = Number.parseFloat(computed.columnGap) || 0;
    const rowGap = Number.parseFloat(computed.rowGap) || 0;
    const first = items[0].getBoundingClientRect();
    const columnsPerPage = Math.max(1, Math.floor((list.clientWidth + columnGap) / (first.width + columnGap)));
    const rowsPerPage = Math.max(1, Math.floor((list.clientHeight + rowGap) / (first.height + rowGap)));
    const pageSize = columnsPerPage * rowsPerPage;

    for (const item of items) {
      const index = Number(item.dataset.fileIndex) || 0;
      const page = Math.floor(index / pageSize);
      const withinPage = index % pageSize;
      const row = Math.floor(withinPage / columnsPerPage);
      const column = withinPage % columnsPerPage;
      item.style.order = '';
      item.style.gridRow = String(row + 1);
      item.style.gridColumn = String(page * columnsPerPage + column + 1);
    }
  }

  function actionButton({ text, title, className = '', onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    if (className) button.className = className;
    button.addEventListener('click', () => {
      void Promise.resolve(onClick()).catch((error) => {
        console.error(error);
        RP4.ui.showToast('파일 작업을 완료하지 못했습니다.');
      });
    });
    return button;
  }

  function createItem(recording) {
    const item = document.createElement('div');
    item.className = 'recording-item';

    const thumb = document.createElement('div');
    thumb.className = 'recording-thumb';
    thumb.innerHTML = VIDEO_ICON;
    thumbnailRecordings.set(thumb, recording);
    thumbnailObserver.observe(thumb);

    const info = document.createElement('div');
    info.className = 'recording-info';
    const name = document.createElement('strong');
    // Names derive from window titles, so they are always set as text, never as HTML.
    name.textContent = recording.name;

    const detail = document.createElement('small');
    detail.textContent = [
      util.formatDate(recording.createdAt),
      recording.durationMs ? util.formatDuration(recording.durationMs) : null,
      recording.width && recording.height ? `${recording.width}x${recording.height}` : null,
      recording.fps ? `${recording.fps} FPS` : null,
      util.formatBytes(recording.size)
    ].filter(Boolean).join(' · ');
    info.append(name, detail);

    const badges = [];
    if (recording.partial || recording.status === 'partial') badges.push(['부분 저장', 'warn']);
    if (recording.status === 'verifying') badges.push(['검증 중', 'info']);
    if (recording.status === 'invalid') badges.push(['검증 실패', 'warn']);
    if (recording.outcome === 'original-preserved') badges.push(['원본 보존', 'warn']);
    if (recording.recovered || recording.outcome === 'recovered') badges.push(['복구됨', 'info']);
    if (recording.managed === false) badges.push(['외부 파일 · 읽기 전용', 'info']);
    if (badges.length > 0) {
      const badgeRow = document.createElement('div');
      badgeRow.className = 'recording-badges';
      for (const [label, tone] of badges) {
        const badge = document.createElement('span');
        badge.className = `recording-badge ${tone}`;
        badge.textContent = label;
        badgeRow.append(badge);
      }
      info.append(badgeRow);
    }

    const actions = document.createElement('div');
    actions.className = 'recording-actions';

    const open = actionButton({
      text: '…',
      title: '파일 위치 열기',
      onClick: async () => {
        const shown = await window.rp4.showFile(recording.filePath);
        if (!shown) RP4.ui.showToast('파일을 찾을 수 없습니다.');
      }
    });
    const play = actionButton({
      text: '▶',
      title: '녹화 재생',
      onClick: async () => {
        const result = await window.rp4.playRecording(recording.filePath);
        if (!result?.ok) RP4.ui.showToast(result?.error || '녹화 파일을 재생할 수 없습니다.');
      }
    });
    const remove = actionButton({
      text: '×',
      title: '녹화 삭제',
      className: 'danger',
      onClick: async () => {
        const confirmed = await RP4.dialog.confirmAction({
          title: '녹화 파일 삭제',
          message: `${recording.name}\n\n이 파일을 휴지통으로 이동할까요?`,
          confirmLabel: '삭제'
        });
        if (!confirmed) return;

        const result = await window.rp4.deleteRecording(recording.filePath);
        if (!result?.deleted) {
          RP4.ui.showToast('녹화 파일을 삭제하지 못했습니다.');
          return;
        }
        RP4.ui.showToast('녹화 파일을 휴지통으로 이동했습니다.');
        await render();
      }
    });
    actions.append(open, play);
    if (recording.managed !== false) actions.append(remove);

    item.append(thumb, info, actions);
    return item;
  }

  async function render() {
    if (!els.recordingList) return;

    try {
      const recordings = await window.rp4.listRecordings();
      for (const thumb of els.recordingList.querySelectorAll('.recording-thumb')) {
        thumbnailObserver.unobserve(thumb);
      }
      els.recordingList.replaceChildren();
      els.recordingList.classList.toggle('is-empty', recordings.length === 0);

      if (!recordings.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '아직 녹화 파일이 없습니다.';
        els.recordingList.append(empty);
        return;
      }

      for (const [index, recording] of recordings.entries()) {
        const item = createItem(recording);
        item.dataset.fileIndex = String(index);
        els.recordingList.append(item);
      }
      if (observedRecordingList !== els.recordingList) {
        if (observedRecordingList) recordingListResizeObserver.unobserve(observedRecordingList);
        observedRecordingList = els.recordingList;
        recordingListResizeObserver.observe(observedRecordingList);
      }
      window.requestAnimationFrame(layoutRecentFiles);
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('녹화 파일 목록을 불러오지 못했습니다.');
    }
  }

  /**
   * Captures a still from a fresh full-resolution grab of the source, so it works at native
   * resolution and while the app is minimized.
   */
  async function performTakeScreenshot() {
    if (state.shuttingDown || state.sourceSelectionPending) return;
    if (!state.selectedSource) {
      RP4.ui.showToast('먼저 캡처 소스를 선택해 주세요.');
      return;
    }

    const snapshot = {
      source: state.selectedSource,
      mode: state.selectedMode,
      areaSelection: { ...state.areaSelection },
      hasAreaSelection: state.hasAreaSelection
    };
    try {
      const configuredFormat = state.appSettings.screenshotFormat || 'png';
      if (configuredFormat !== 'webp') {
        const saved = await window.rp4.captureAndSaveScreenshot({
          sourceId: snapshot.source.id,
          mode: snapshot.mode,
          areaSelection: snapshot.areaSelection,
          hasAreaSelection: snapshot.hasAreaSelection,
          format: configuredFormat,
          quality: state.appSettings.screenshotQuality
        });
        RP4.ui.showToast(`스크린샷 저장: ${saved.fileName} (${saved.width}x${saved.height})`);
        return;
      }

      // Electron NativeImage has no WebP encoder, so WebP alone uses the renderer path.
      const canvas = await RP4.capture.captureStill(snapshot);
      const requestedMime = configuredFormat === 'jpeg'
        ? 'image/jpeg'
        : configuredFormat === 'webp' ? 'image/webp' : 'image/png';
      const quality = util.clamp(Number(state.appSettings.screenshotQuality) || 100, 10, 100) / 100;
      const blob = await new Promise((resolve) => {
        if (requestedMime === 'image/png') canvas.toBlob(resolve, requestedMime);
        else canvas.toBlob(resolve, requestedMime, quality);
      });
      if (!blob) throw new Error('이미지를 만들 수 없습니다.');

      const format = blob.type === 'image/jpeg'
        ? 'jpeg'
        : blob.type === 'image/webp' ? 'webp' : 'png';

      const buffer = await blob.arrayBuffer();
      const saved = await window.rp4.saveScreenshot({
        buffer,
        format,
        width: canvas.width,
        height: canvas.height
      });
      RP4.ui.showToast(`스크린샷 저장: ${saved.fileName} (${canvas.width}x${canvas.height})`);
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('스크린샷 저장에 실패했습니다.');
    }
  }

  function takeScreenshot() {
    if (state.screenshotPromise) return state.screenshotPromise;
    const promise = performTakeScreenshot();
    state.screenshotPromise = promise;
    void promise.finally(() => {
      if (state.screenshotPromise === promise) state.screenshotPromise = null;
    });
    return promise;
  }

  async function finalizeForShutdown() {
    await state.screenshotPromise?.catch(() => {});
  }

  RP4.files = { render, takeScreenshot, finalizeForShutdown, VIDEO_ICON };
}(window.RP4));
