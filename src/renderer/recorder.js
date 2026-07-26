'use strict';

/*
 * Preview and normal (start/stop) recording.
 */
(function initRecorder(RP4) {
  const { state, els, util } = RP4;

  const CHUNK_INTERVAL_MS = 2000;

  function cleanupPreview() {
    if (state.preview) {
      try {
        state.preview.cleanup();
      } catch {
        // best effort
      }
      state.preview = null;
    }
    els.previewVideo.srcObject = null;
  }

  async function playPreview() {
    try {
      await els.previewVideo.play();
    } catch {
      // Autoplay can reject harmlessly; the stream is still attached.
    }
  }

  /**
   * Starts the preview. Guarded by a generation counter: rapidly switching sources used to
   * interleave two startPreview calls, letting the stale one overwrite the newer stream and
   * leak a live capture (leaving the screen-capture indicator lit).
   */
  async function startPreview() {
    if (!state.selectedSource || state.isRecording || state.clip) return;

    const generation = ++state.previewGeneration;
    cleanupPreview();

    let capture = null;
    try {
      capture = await RP4.capture.createCaptureStream({
        audio: false,
        // Area mode previews the cropped region so the selection is actually visible.
        cropArea: state.selectedMode === 'area',
        includeMic: false
      });

      if (generation !== state.previewGeneration) {
        capture.cleanup();
        return;
      }

      state.preview = capture;
      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await playPreview();

      els.previewPlaceholder.classList.add('hidden');
      RP4.app.updatePreviewMeta(capture.output);
      RP4.ui.setStatus('준비 완료', '녹화 준비가 완료되었습니다.', 'ready');
    } catch (error) {
      console.error(error);
      capture?.cleanup();
      if (generation !== state.previewGeneration) return;

      state.preview = null;
      els.previewPlaceholder.classList.remove('hidden');
      RP4.ui.setStatus('미리보기 실패', '선택한 소스를 열 수 없습니다.', 'warn');
      RP4.ui.showToast('미리보기를 시작하지 못했습니다. 다른 소스를 선택해 주세요.');
    }
  }

  async function restartPreview() {
    if (state.isRecording || state.clip) return;
    await startPreview();
  }

  function recorderOptions(profile, mimeType) {
    const options = {
      videoBitsPerSecond: profile.bitrateMbps * 1000 * 1000,
      audioBitsPerSecond: profile.audioBitrateKbps * 1000
    };
    if (mimeType) options.mimeType = mimeType;
    return options;
  }

  /** Elapsed recording time with paused stretches excluded. */
  function elapsedMs() {
    if (!state.startedAt) return 0;
    const pausedNow = state.isPaused && state.pausedAt ? Date.now() - state.pausedAt : 0;
    return Math.max(0, Date.now() - state.startedAt - state.pausedAccumMs - pausedNow);
  }

  async function toggleRecording() {
    if (state.isRecording) {
      await stopRecording();
      return;
    }
    await startRecording();
  }

  async function startRecording() {
    if (state.isRecording) return;

    if (state.clip) {
      RP4.ui.showToast('클립 녹화 모드를 중지한 뒤 일반 녹화를 시작해 주세요.');
      return;
    }

    if (!state.selectedSource) {
      await RP4.app.selectDefaultScreen();
    }
    if (!state.selectedSource) return;

    const profile = RP4.profile.get();
    const codec = RP4.capture.pickRecorderMime(profile.format);
    if (!codec) {
      RP4.ui.showToast('이 시스템에서 지원하는 녹화 코덱을 찾지 못했습니다.');
      return;
    }

    let session = null;
    let capture = null;

    try {
      RP4.ui.setStatus('녹화 준비 중', '캡처 스트림을 준비하고 있습니다.', 'warn');
      state.previewGeneration += 1;
      cleanupPreview();

      capture = await RP4.capture.createCaptureStream({
        audio: profile.systemAudioEnabled,
        cropArea: state.selectedMode === 'area',
        includeMic: profile.micEnabled
      });

      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await playPreview();
      els.previewPlaceholder.classList.add('hidden');

      if (capture.systemAudioUnavailable) {
        RP4.ui.showToast('이 소스에서는 시스템 오디오를 사용할 수 없어 영상만 녹화합니다.');
      }

      session = await window.rp4.startRecording({
        mode: state.selectedMode,
        modeLabel: RP4.app.getModeLabel(state.selectedMode),
        sourceName: RP4.app.getSourceTitle(state.selectedSource),
        format: profile.format,
        mimeType: codec.mimeType,
        width: capture.output.width,
        height: capture.output.height,
        fps: profile.fps,
        bitrateMbps: profile.bitrateMbps,
        encoderPreset: profile.encoderPreset,
        audioBitrateKbps: profile.audioBitrateKbps
      });

      const recorder = new MediaRecorder(capture.stream, recorderOptions(profile, codec.mimeType));

      state.recording = {
        ...capture,
        recorder,
        sessionId: session.sessionId,
        codec,
        writeQueue: Promise.resolve(),
        aborted: false
      };
      state.isRecording = true;
      state.isPaused = false;
      state.startedAt = Date.now();
      state.pausedAccumMs = 0;
      state.pausedAt = 0;

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) enqueueChunk(event.data);
      });
      recorder.addEventListener('error', (event) => {
        console.error(event.error || event);
        RP4.ui.showToast('녹화 중 오류가 발생했습니다.');
      });
      recorder.addEventListener('stop', () => {
        void finalizeRecording();
      }, { once: true });

      recorder.start(CHUNK_INTERVAL_MS);
      RP4.app.updateRecordingUi();
      RP4.app.startTimer();

      const label = session.directToTarget
        ? `${profile.format.toUpperCase()}로 직접 저장합니다.`
        : '저장 시 빠른 변환이 필요합니다.';
      RP4.ui.setStatus('녹화 중', `${RP4.app.getSourceTitle(state.selectedSource)} · ${label}`, 'recording');
    } catch (error) {
      console.error(error);
      if (session?.sessionId) {
        try {
          await window.rp4.stopRecording({ sessionId: session.sessionId });
        } catch {
          // ignore
        }
      }
      capture?.cleanup();
      resetRecordingState();
      RP4.app.updateRecordingUi();
      await startPreview();
      RP4.ui.setStatus('녹화 실패', '녹화를 시작하지 못했습니다.', 'warn');
      RP4.ui.showToast(`녹화를 시작하지 못했습니다. ${error?.message || ''}`.trim());
    }
  }

  /**
   * Queues a chunk write. A failure now aborts the recording instead of only showing a
   * toast and continuing to produce a file with a hole in it.
   */
  function enqueueChunk(blob) {
    const session = state.recording;
    if (!session || session.aborted) return;

    const sessionId = session.sessionId;
    session.writeQueue = session.writeQueue
      .then(async () => {
        if (session.aborted) return;
        const buffer = await blob.arrayBuffer();
        const result = await window.rp4.writeRecordingChunk({ sessionId, buffer });
        if (result?.warning) {
          RP4.ui.showToast(result.warning);
        }
      })
      .catch((error) => {
        if (session.aborted) return;
        session.aborted = true;
        console.error(error);
        RP4.ui.showToast(`녹화를 중지합니다. ${error?.message || '데이터를 저장할 수 없습니다.'}`);
        RP4.ui.setStatus('녹화 오류', '데이터를 저장할 수 없어 녹화를 중지했습니다.', 'warn');
        try {
          if (session.recorder.state !== 'inactive') session.recorder.stop();
        } catch {
          // ignore
        }
      });
  }

  async function stopRecording() {
    const session = state.recording;
    if (!session || session.recorder.state === 'inactive') return;
    RP4.ui.setStatus('저장 중', '녹화 파일을 마무리하고 있습니다.', 'warn');
    session.recorder.stop();
  }

  /**
   * Finishes the recording. In the normal path the file is already complete on disk, so
   * this is a close plus a rename and returns immediately.
   */
  async function finalizeRecording() {
    const session = state.recording;
    if (!session) return;

    const sessionId = session.sessionId;
    const durationMs = elapsedMs();

    try {
      await session.writeQueue;
    } catch {
      // Already surfaced by enqueueChunk.
    }

    try {
      const saved = await window.rp4.stopRecording({ sessionId, durationMs });
      resetRecordingState();
      RP4.app.updateRecordingUi();
      await RP4.files.render();
      await startPreview();

      if (!saved) {
        RP4.ui.setStatus('저장 취소', '기록된 데이터가 없습니다.', 'warn');
        return;
      }

      RP4.ui.setStatus('저장 완료', saved.name, 'ready');
      if (saved.conversionError) {
        RP4.ui.showToast(`원본을 그대로 저장했습니다: ${saved.name}`);
      } else {
        RP4.ui.showToast(`저장 완료: ${saved.name}`);
      }
    } catch (error) {
      console.error(error);
      resetRecordingState();
      RP4.app.updateRecordingUi();
      await startPreview();
      RP4.ui.setStatus('저장 실패', '녹화 파일 저장을 완료하지 못했습니다.', 'warn');
      RP4.ui.showToast('녹화 파일 저장을 완료하지 못했습니다.');
    }
  }

  function togglePause() {
    const session = state.recording;
    if (!session || !state.isRecording) return;
    const recorder = session.recorder;

    if (recorder.state === 'recording') {
      recorder.pause();
      state.isPaused = true;
      // Remember when the pause began so neither the timer nor the saved duration counts
      // paused time.
      state.pausedAt = Date.now();
      RP4.app.updateRecordingUi();
      RP4.ui.setStatus('일시정지', '녹화가 일시정지되었습니다.', 'warn');
      return;
    }

    if (recorder.state === 'paused') {
      recorder.resume();
      if (state.pausedAt) {
        state.pausedAccumMs += Date.now() - state.pausedAt;
        state.pausedAt = 0;
      }
      state.isPaused = false;
      RP4.app.updateRecordingUi();
      RP4.ui.setStatus('녹화 중', `${RP4.app.getSourceTitle(state.selectedSource)} 녹화 중입니다.`, 'recording');
    }
  }

  function resetRecordingState() {
    RP4.app.stopTimer();
    if (state.recording) {
      try {
        state.recording.cleanup();
      } catch {
        // best effort
      }
    }
    state.recording = null;
    state.isRecording = false;
    state.isPaused = false;
    state.startedAt = 0;
    state.pausedAccumMs = 0;
    state.pausedAt = 0;
  }

  /** Waits for an in-flight recording to finish, used while the app is shutting down. */
  async function finalizeForShutdown() {
    if (!state.isRecording) return;
    const done = new Promise((resolve) => {
      const poll = () => {
        if (!state.isRecording) {
          resolve();
          return;
        }
        window.setTimeout(poll, 100);
      };
      poll();
    });
    await stopRecording();
    await Promise.race([done, util.sleep(15000)]);
  }

  RP4.recorder = {
    startPreview,
    restartPreview,
    cleanupPreview,
    toggleRecording,
    startRecording,
    stopRecording,
    togglePause,
    elapsedMs,
    finalizeForShutdown
  };
}(window.RP4));
