'use strict';

/*
 * Saved recordings list and screenshots.
 */
(function initFiles(RP4) {
  const { state, els, util } = RP4;

  const VIDEO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="13" rx="1.6"/><path d="M8 21h8M12 18v3"/></svg>';

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
    actions.append(open, play, remove);

    item.append(thumb, info, actions);
    return item;
  }

  async function render() {
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

      for (const recording of recordings) {
        els.recordingList.append(createItem(recording));
      }
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('녹화 파일 목록을 불러오지 못했습니다.');
    }
  }

  /**
   * Captures a still from a fresh full-resolution grab of the source, so it works at native
   * resolution and while the app is minimized.
   */
  async function takeScreenshot() {
    if (!state.selectedSource) {
      RP4.ui.showToast('먼저 캡처 소스를 선택해 주세요.');
      return;
    }

    try {
      const canvas = await RP4.capture.captureStill();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('이미지를 만들 수 없습니다.');

      const buffer = await blob.arrayBuffer();
      const saved = await window.rp4.saveScreenshot({
        buffer,
        width: canvas.width,
        height: canvas.height
      });
      RP4.ui.showToast(`스크린샷 저장: ${saved.fileName} (${canvas.width}x${canvas.height})`);
    } catch (error) {
      console.error(error);
      RP4.ui.showToast('스크린샷 저장에 실패했습니다.');
    }
  }

  RP4.files = { render, takeScreenshot, VIDEO_ICON };
}(window.RP4));
