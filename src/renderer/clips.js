'use strict';

/*
 * Clip mode: a rolling buffer of the most recent footage.
 *
 * The previous implementation stopped and restarted a MediaRecorder every 5 seconds and
 * stitched the pieces back together with ffmpeg's concat demuxer using wall-clock duration
 * hints. That produced a visible hitch at every boundary, drifting audio, and a full
 * re-encode on save.
 *
 * A recorder epoch is kept intact from its first Blob onward. Saving sends the complete
 * epoch and FFmpeg extracts its most recent interval. Blob boundaries are never treated as
 * independently decodable media boundaries. When the memory ceiling is reached, a new
 * intact epoch begins.
 */
(function initClips(RP4) {
  const { state, els, util } = RP4;

  const CHUNK_MS = 1000;

  function bufferedBytes(session) {
    return (session.initChunk?.size || 0)
      + session.chunks.reduce((total, entry) => total + entry.blob.size, 0);
  }

  function clipLimitBytes() {
    const limitMb = Number(state.appSettings.clipBufferLimitMb) || 256;
    return limitMb * 1024 * 1024;
  }

  /** Starts a fresh, independently valid recording epoch at the memory ceiling. */
  function pruneBuffer(session) {
    if (!session) return;
    if (bufferedBytes(session) <= clipLimitBytes() || session.rotationPromise) return;
    session.trimmedForSize = true;
    session.rotationPromise = rotateBuffer(session).finally(() => {
      session.rotationPromise = null;
    });
  }

  function createClipRecorder(session, profile) {
    const recorder = new MediaRecorder(session.stream, {
      mimeType: session.codec.mimeType,
      videoBitsPerSecond: profile.bitrateMbps * 1000 * 1000,
      audioBitsPerSecond: profile.audioBitrateKbps * 1000,
      videoKeyFrameIntervalDuration: CHUNK_MS
    });

    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data || event.data.size === 0) {
        session.pendingFlush?.resolve();
        return;
      }
      if (!session.initChunk) session.initChunk = event.data;
      else session.chunks.push({ blob: event.data, at: Date.now() });
      pruneBuffer(session);
      session.pendingFlush?.resolve();
    });
    recorder.addEventListener('error', (event) => {
      console.error(event.error || event);
      RP4.ui.showToast('클립 녹화 중 오류가 발생했습니다.');
    });
    return recorder;
  }

  async function rotateBuffer(session) {
    if (state.clip !== session || state.captureLifecycle !== 'clip') return;
    const previous = session.recorder;
    if (previous.state !== 'inactive') {
      const stopped = new Promise((resolve) => previous.addEventListener('stop', resolve, { once: true }));
      previous.stop();
      await stopped;
    }
    if (state.clip !== session) return;

    session.initChunk = null;
    session.chunks = [];
    session.bufferStartedAt = Date.now();
    session.recorder = createClipRecorder(session, session.profile);
    session.recorder.start(CHUNK_MS);
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

    if (!state.selectedSource) {
      await RP4.app.selectDefaultScreen();
    }
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
        recorder: null,
        codec,
        profile,
        initChunk: null,
        chunks: [],
        startedAt: Date.now(),
        bufferStartedAt: Date.now(),
        trimmedForSize: false,
        pendingFlush: null,
        rotationPromise: null
      };
      session.recorder = createClipRecorder(session, profile);
      session.recorder.start(CHUNK_MS);

      state.clip = session;
      RP4.lifecycle.transition(operationId, 'clip');
      RP4.app.startTimer();
      RP4.app.updateClipUi();
      RP4.ui.setStatus(
        '클립 녹화 중',
        `${util.formatSeconds(profile.clipDurationSeconds)} 버퍼를 유지하고 있습니다.`,
        'recording'
      );
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

  /** Asks the recorder for everything buffered so far and waits for it to arrive. */
  async function flush(session) {
    if (session?.rotationPromise) await session.rotationPromise;
    if (!session || session.recorder.state !== 'recording') return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        session.pendingFlush = null;
        resolve();
      };

      session.pendingFlush = { resolve: finish };
      try {
        session.recorder.requestData();
      } catch {
        finish();
        return;
      }
      // Never hang the save on a recorder that does not answer.
      window.setTimeout(finish, 1500);
    });
  }

  async function stopClipMode() {
    const session = state.clip;
    if (!session || state.captureLifecycle !== 'clip') return;

    RP4.lifecycle.transition(session.operationId, 'stopping-clip');
    RP4.ui.setStatus('클립 모드 중지 중', '클립 버퍼를 정리하고 있습니다.', 'warn');
    state.clip = null;

    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    } catch {
      // ignore
    }
    try {
      session.cleanup();
    } catch {
      // best effort
    }

    RP4.app.stopTimer();
    RP4.lifecycle.finish(session.operationId);
    RP4.app.updateClipUi();
    await RP4.recorder.startPreview();
    RP4.ui.setStatus('준비 완료', '녹화 준비가 완료되었습니다.', 'ready');
  }

  async function saveClip() {
    const session = state.clip;
    if (!session || state.clipSaving || state.captureLifecycle !== 'clip') return;

    state.clipSaving = true;
    RP4.lifecycle.transition(session.operationId, 'saving-clip');
    RP4.app.updateClipUi();
    let clipSession = null;

    try {
      await flush(session);

      const profile = RP4.profile.get();
      const savePoint = Date.now();
      const windowMs = profile.clipDurationSeconds * 1000;

      if (!session.initChunk || session.chunks.length === 0) {
        RP4.ui.showToast('아직 저장할 클립 데이터가 없습니다.');
        return;
      }

      // Every Blob from this recorder epoch is sent in order. FFmpeg trims the complete
      // stream from the end, so no arbitrary Blob suffix is treated as self-contained.
      const selected = session.chunks;
      const estimatedMs = Math.min(windowMs, Math.max(CHUNK_MS, savePoint - session.bufferStartedAt));

      RP4.ui.setStatus('클립 저장 중', '최근 장면을 파일로 저장하고 있습니다.', 'warn');

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
        clip: true
      };

      // Stream each retained MediaRecorder delivery separately. Building one giant Blob,
      // flattening it to an ArrayBuffer, and cloning it through IPC could otherwise create
      // several simultaneous copies of a hundreds-of-megabytes clip.
      clipSession = await window.rp4.startRecording(meta);
      const initResult = await util.writeBlobInSlices(clipSession.sessionId, session.initChunk);
      if (initResult?.warning) throw new Error(initResult.warning);
      for (const entry of selected) {
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
      if (saved.status === 'partial') throw new Error(saved.failureReason || '클립이 일부만 저장됐습니다.');

      await RP4.files.render();

      if (state.clip) {
        RP4.ui.setStatus(
          '클립 녹화 중',
          `${util.formatSeconds(profile.clipDurationSeconds)} 버퍼를 유지하고 있습니다.`,
          'recording'
        );
      }
      RP4.ui.showToast(`클립 저장 완료: ${saved.name}`);

      if (session.trimmedForSize) {
        session.trimmedForSize = false;
        RP4.ui.showToast(
          `메모리 한도(${state.appSettings.clipBufferLimitMb}MB)에 맞춰 버퍼를 줄였습니다.`
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
      state.clipSaving = false;
      if (state.clip === session) RP4.lifecycle.transition(session.operationId, 'clip');
      RP4.app.updateClipUi();
    }
  }

  function bufferStatus() {
    const session = state.clip;
    if (!session) return null;
    return {
      chunks: session.chunks.length,
      bytes: bufferedBytes(session),
      limitBytes: clipLimitBytes()
    };
  }

  RP4.clips = {
    toggleClipMode,
    startClipMode,
    stopClipMode,
    saveClip,
    pruneActiveBuffer,
    bufferStatus
  };
}(window.RP4));
