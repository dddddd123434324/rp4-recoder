'use strict';

/*
 * Clip mode keeps one complete MediaRecorder epoch. Blob boundaries are not independent
 * files, so saving always snapshots a full epoch and lets FFmpeg trim from its end.
 * Rotation and snapshot capture share one operation queue; an epoch being rotated is held
 * until a save request that raced with the rotation has captured its immutable snapshot.
 */
(function initClips(RP4) {
  const { state, els, util } = RP4;

  const CHUNK_MS = 1000;

  function epochBytes(epoch) {
    if (!epoch) return 0;
    return (epoch.initChunk?.size || 0)
      + epoch.chunks.reduce((total, entry) => total + entry.blob.size, 0);
  }

  function clipLimitBytes() {
    const limitMb = Number(state.appSettings.clipBufferLimitMb) || 256;
    return limitMb * 1024 * 1024;
  }

  function enqueueOperation(session, task) {
    const result = session.operationQueue.then(task, task);
    session.operationQueue = result.catch(() => {});
    return result;
  }

  function resolveFlush(epoch) {
    epoch?.pendingFlush?.resolve();
  }

  function failClipSession(session, error) {
    if (!session || session.failure || session.stopping) return;
    session.failure = error?.message || String(error || 'MediaRecorder가 중단되었습니다.');
    console.error(error);
    RP4.ui.setStatus('클립 녹화 오류', '클립 버퍼가 중단되어 모드를 종료합니다.', 'warn');
    RP4.ui.showToast(`클립 녹화를 중지합니다. ${session.failure}`);
    void stopClipMode(session, { failed: true });
  }

  function createEpoch(session) {
    const epoch = {
      recorder: null,
      initChunk: null,
      chunks: [],
      startedAt: Date.now(),
      endedAt: null,
      pendingFlush: null
    };
    const profile = session.profile;
    const recorder = new MediaRecorder(session.stream, {
      mimeType: session.codec.mimeType,
      videoBitsPerSecond: profile.bitrateMbps * 1000 * 1000,
      audioBitsPerSecond: profile.audioBitrateKbps * 1000,
      videoKeyFrameIntervalDuration: CHUNK_MS
    });
    epoch.recorder = recorder;

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        if (!epoch.initChunk) epoch.initChunk = event.data;
        else epoch.chunks.push({ blob: event.data, at: Date.now() });
        if (session.currentEpoch === epoch) pruneBuffer(session);
      }
      resolveFlush(epoch);
    });
    recorder.addEventListener('error', (event) => {
      failClipSession(session, event.error || new Error('MediaRecorder가 클립 녹화 중 실패했습니다.'));
    });
    return epoch;
  }

  function startEpoch(session) {
    const epoch = createEpoch(session);
    session.currentEpoch = epoch;
    epoch.recorder.start(CHUNK_MS);
    return epoch;
  }

  function pruneBuffer(session) {
    if (!session || state.clip !== session || session.stopping) return;
    if (epochBytes(session.currentEpoch) <= clipLimitBytes() || session.rotationPromise) return;

    session.trimmedForSize = true;
    session.rotationPromise = enqueueOperation(session, () => rotateBuffer(session))
      .catch((error) => failClipSession(session, error))
      .finally(() => { session.rotationPromise = null; });
  }

  async function stopEpoch(epoch) {
    if (!epoch || epoch.recorder.state === 'inactive') return;
    const stopped = new Promise((resolve) => {
      epoch.recorder.addEventListener('stop', resolve, { once: true });
    });
    epoch.recorder.stop();
    await stopped;
    epoch.endedAt = Date.now();
  }

  async function rotateBuffer(session) {
    if (state.clip !== session || session.stopping) return;
    const previous = session.currentEpoch;
    await stopEpoch(previous);
    if (state.clip !== session || session.stopping) return;

    session.previousEpoch = previous;
    startEpoch(session);
    if (session.pendingSaveRequests === 0) session.previousEpoch = null;
  }

  async function flushEpoch(epoch) {
    if (!epoch || epoch.recorder.state !== 'recording') return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        epoch.pendingFlush = null;
        resolve();
      };
      epoch.pendingFlush = { resolve: finish };
      try {
        epoch.recorder.requestData();
      } catch {
        finish();
        return;
      }
      window.setTimeout(finish, 1500);
    });
  }

  async function captureSnapshot(session, requestedAt) {
    const previous = session.previousEpoch;
    const usePrevious = previous
      && requestedAt >= previous.startedAt
      && requestedAt <= (previous.endedAt || requestedAt);
    const epoch = usePrevious ? previous : session.currentEpoch;
    if (!usePrevious) await flushEpoch(epoch);

    return {
      requestedAt,
      startedAt: epoch?.startedAt || requestedAt,
      endedAt: usePrevious ? epoch.endedAt : Date.now(),
      initChunk: epoch?.initChunk || null,
      chunks: epoch?.chunks.slice() || [],
      trimmedForSize: session.trimmedForSize
    };
  }

  function pruneActiveBuffer() {
    if (state.clip) pruneBuffer(state.clip);
  }

  async function toggleClipMode() {
    if (state.captureLifecycle === 'clip') {
      await stopClipMode();
      return;
    }
    if (RP4.lifecycle.isBusy()) return;
    await startClipMode();
  }

  async function startClipMode() {
    const operationId = RP4.lifecycle.begin('starting-clip');
    if (operationId == null) return;

    if (!state.selectedSource) await RP4.app.selectDefaultScreen();
    if (!state.selectedSource) {
      RP4.lifecycle.finish(operationId);
      return;
    }

    const profile = RP4.profile.get();
    const codec = RP4.capture.pickRecorderMime(profile.format);
    if (!codec) {
      RP4.lifecycle.finish(operationId);
      RP4.ui.showToast('이 시스템에서 지원하는 녹화 코덱을 찾지 못했습니다.');
      return;
    }

    let capture = null;
    try {
      RP4.ui.setStatus('클립 모드 준비 중', '최근 장면 버퍼를 준비하고 있습니다.', 'warn');
      state.previewGeneration += 1;
      RP4.recorder.cleanupPreview();
      capture = await RP4.capture.createCaptureStream({
        audio: profile.systemAudioEnabled,
        cropArea: state.selectedMode === 'area',
        includeMic: profile.micEnabled
      });

      if (!RP4.lifecycle.isCurrent(operationId, 'starting-clip')) {
        capture.cleanup();
        return;
      }

      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await els.previewVideo.play().catch(() => {});
      els.previewPlaceholder.classList.add('hidden');

      const session = {
        ...capture,
        operationId,
        codec,
        profile,
        currentEpoch: null,
        previousEpoch: null,
        startedAt: Date.now(),
        trimmedForSize: false,
        rotationPromise: null,
        operationQueue: Promise.resolve(),
        pendingSaveRequests: 0,
        failure: null,
        stopping: false
      };
      startEpoch(session);
      for (const track of capture.stream.getTracks()) {
        track.addEventListener('ended', () => {
          failClipSession(session, new Error('캡처 소스가 종료되었습니다.'));
        }, { once: true });
      }

      state.clip = session;
      RP4.lifecycle.transition(operationId, 'clip');
      RP4.app.startTimer();
      RP4.app.updateClipUi();
      RP4.ui.setStatus('클립 녹화 중', '최근 장면을 확보하고 있습니다.', 'recording');
    } catch (error) {
      console.error(error);
      capture?.cleanup();
      if (state.clip?.operationId === operationId) state.clip = null;
      RP4.lifecycle.finish(operationId);
      RP4.app.updateClipUi();
      await RP4.recorder.startPreview();
      RP4.ui.setStatus('클립 모드 실패', '클립 녹화 모드를 시작하지 못했습니다.', 'warn');
      RP4.ui.showToast('클립 녹화 모드를 시작하지 못했습니다.');
    }
  }

  async function stopClipMode(expectedSession = state.clip, { failed = false } = {}) {
    const session = expectedSession;
    if (!session || state.clip !== session || session.stopping) return;
    session.stopping = true;
    RP4.lifecycle.transition(session.operationId, 'stopping-clip');
    if (!failed) RP4.ui.setStatus('클립 모드 중지 중', '클립 버퍼를 정리하고 있습니다.', 'warn');
    state.clip = null;

    await enqueueOperation(session, async () => {
      try {
        await stopEpoch(session.currentEpoch);
      } catch {
        // The capture tracks are still cleaned up below.
      }
    });
    try {
      session.cleanup();
    } catch {
      // best effort
    }

    RP4.app.stopTimer();
    RP4.lifecycle.finish(session.operationId);
    RP4.app.updateClipUi();
    await RP4.recorder.startPreview();
    if (!failed) RP4.ui.setStatus('준비 완료', '녹화 준비가\n완료되었습니다.', 'ready');
  }

  async function performSaveClip(session) {
    const requestedAt = Date.now();
    session.pendingSaveRequests += 1;
    state.clipSaving = true;
    RP4.lifecycle.transition(session.operationId, 'saving-clip');
    RP4.app.updateClipUi();
    let clipSession = null;
    let requestReleased = false;

    try {
      const snapshot = await enqueueOperation(session, () => captureSnapshot(session, requestedAt));
      session.pendingSaveRequests -= 1;
      requestReleased = true;
      if (session.pendingSaveRequests === 0) session.previousEpoch = null;

      const profile = RP4.profile.get();
      const windowMs = profile.clipDurationSeconds * 1000;
      if (!snapshot.initChunk || snapshot.chunks.length === 0) {
        RP4.ui.showToast('아직 저장할 클립 데이터가 없습니다.');
        return;
      }

      const estimatedMs = Math.min(
        windowMs,
        Math.max(CHUNK_MS, snapshot.requestedAt - snapshot.startedAt)
      );
      RP4.ui.setStatus('클립 저장 중', '클릭 시점까지의 최근 장면을 저장하고 있습니다.', 'warn');

      const meta = {
        mode: state.selectedMode,
        modeLabel: `${RP4.app.getModeLabel(state.selectedMode)} 클립`,
        sourceName: RP4.app.getSourceTitle(state.selectedSource),
        format: profile.format,
        mimeType: session.codec.mimeType,
        width: session.output.width,
        height: session.output.height,
        fps: profile.fps,
        bitrateMbps: profile.bitrateMbps,
        audioBitrateKbps: profile.audioBitrateKbps,
        encoderPreset: profile.encoderPreset,
        durationMs: estimatedMs,
        trimRecentMs: estimatedMs,
        trimEndOffsetMs: Math.max(0, snapshot.endedAt - snapshot.requestedAt),
        clip: true
      };

      clipSession = await window.rp4.startRecording(meta);
      const initResult = await util.writeBlobInSlices(clipSession.sessionId, snapshot.initChunk);
      if (initResult?.warning) throw new Error(initResult.warning);
      for (const entry of snapshot.chunks) {
        const result = await util.writeBlobInSlices(clipSession.sessionId, entry.blob);
        if (result?.warning) throw new Error(result.warning);
      }
      const saved = await window.rp4.stopRecording({
        sessionId: clipSession.sessionId,
        durationMs: estimatedMs,
        meta
      });
      clipSession = null;
      if (!saved) throw new Error('클립 저장 결과가 없습니다.');

      await RP4.files.render();
      if (saved.outcome === 'partial' || saved.status === 'partial') {
        RP4.ui.setStatus('클립 부분 저장됨', saved.name, 'warn');
        RP4.ui.showToast(`클립 일부만 저장했습니다: ${saved.name}`);
      } else if (saved.outcome === 'original-preserved' || saved.conversionError) {
        RP4.ui.setStatus('클립 원본 보존됨', saved.name, 'warn');
        RP4.ui.showToast(`최근 구간 변환에 실패해 전체 원본을 보존했습니다: ${saved.name}`);
      } else {
        RP4.ui.setStatus('클립 저장 완료', saved.name, 'ready');
        RP4.ui.showToast(`클립 저장 완료: ${saved.name}`);
      }

      if (snapshot.trimmedForSize) {
        session.trimmedForSize = false;
        RP4.ui.showToast(
          `메모리 한도(${state.appSettings.clipBufferLimitMb}MB) 때문에 목표 길이보다 짧을 수 있습니다.`
        );
      }
    } catch (error) {
      console.error(error);
      if (clipSession) {
        await window.rp4.stopRecording({
          sessionId: clipSession.sessionId,
          durationMs: 0,
          failureReason: error?.message || '클립 저장 중 오류가 발생했습니다.'
        }).catch(() => {});
      }
      RP4.ui.setStatus('클립 저장 실패', '클립 파일 저장을 완료하지 못했습니다.', 'warn');
      RP4.ui.showToast('클립 파일 저장을 완료하지 못했습니다.');
    } finally {
      if (!requestReleased && session.pendingSaveRequests > 0) session.pendingSaveRequests -= 1;
      if (session.pendingSaveRequests === 0) session.previousEpoch = null;
      state.clipSaving = false;
      if (state.clip === session) RP4.lifecycle.transition(session.operationId, 'clip');
      RP4.app.updateClipUi();
      pruneActiveBuffer();
    }
  }

  function saveClip() {
    const session = state.clip;
    if (!session || state.captureLifecycle !== 'clip') return Promise.resolve();
    if (state.clipSavePromise) return state.clipSavePromise;

    const promise = performSaveClip(session);
    state.clipSavePromise = promise;
    void promise.finally(() => {
      if (state.clipSavePromise === promise) state.clipSavePromise = null;
    });
    return promise;
  }

  /** Waits for a snapshot/write/conversion already in progress before releasing capture. */
  async function finalizeForShutdown() {
    await state.clipSavePromise?.catch(() => {});
    if (state.clip) await stopClipMode(state.clip);
  }

  function bufferStatus() {
    const session = state.clip;
    const epoch = session?.currentEpoch;
    if (!session || !epoch) return null;
    return {
      chunks: epoch.chunks.length,
      bytes: epochBytes(epoch),
      limitBytes: clipLimitBytes(),
      availableMs: Math.max(0, Date.now() - epoch.startedAt),
      targetMs: session.profile.clipDurationSeconds * 1000,
      limitedByCapacity: session.trimmedForSize
    };
  }

  RP4.clips = {
    toggleClipMode,
    startClipMode,
    stopClipMode,
    saveClip,
    finalizeForShutdown,
    pruneActiveBuffer,
    bufferStatus
  };
}(window.RP4));
