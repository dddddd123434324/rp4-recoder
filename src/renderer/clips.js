'use strict';

/*
 * Clip mode: a rolling buffer of the most recent footage.
 *
 * The previous implementation stopped and restarted a MediaRecorder every 5 seconds and
 * stitched the pieces back together with ffmpeg's concat demuxer using wall-clock duration
 * hints. That produced a visible hitch at every boundary, drifting audio, and a full
 * re-encode on save.
 *
 * A single recorder now runs continuously. Its first chunk is the container
 * initialisation segment, which is kept aside; the following chunks are independent media
 * fragments held in a ring. A clip is the init segment plus a suffix of that ring, so there
 * are no seams and no re-encode.
 */
(function initClips(RP4) {
  const { state, els, util } = RP4;

  const CHUNK_MS = 1000;
  // A little slack so the requested duration is always fully covered.
  const PRUNE_MARGIN_MS = 3000;

  function bufferedBytes(session) {
    return session.chunks.reduce((total, entry) => total + entry.blob.size, 0);
  }

  function clipLimitBytes() {
    const limitMb = Number(state.appSettings.clipBufferLimitMb) || 256;
    return limitMb * 1024 * 1024;
  }

  /**
   * Trims the ring by age and by size. The byte ceiling matters: a 7200 second buffer at
   * 35 Mbps would otherwise try to hold about 31 GB in memory.
   */
  function pruneBuffer(session, now = Date.now()) {
    if (!session) return;

    const durationMs = RP4.profile.get().clipDurationSeconds * 1000;
    const cutoff = now - durationMs - PRUNE_MARGIN_MS;
    while (session.chunks.length > 0 && session.chunks[0].at < cutoff) {
      session.chunks.shift();
    }

    const limit = clipLimitBytes();
    let total = bufferedBytes(session);
    while (session.chunks.length > 1 && total > limit) {
      total -= session.chunks.shift().blob.size;
      session.trimmedForSize = true;
    }
  }

  function pruneActiveBuffer() {
    if (state.clip) pruneBuffer(state.clip);
  }

  async function toggleClipMode() {
    if (state.clip) {
      await stopClipMode();
      return;
    }
    await startClipMode();
  }

  async function startClipMode() {
    if (state.isRecording) {
      RP4.ui.showToast('일반 녹화 중에는 클립 녹화 모드를 시작할 수 없습니다.');
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

      els.previewVideo.srcObject = capture.stream;
      els.previewVideo.muted = true;
      await els.previewVideo.play().catch(() => {});
      els.previewPlaceholder.classList.add('hidden');

      const recorder = new MediaRecorder(capture.stream, {
        mimeType: codec.mimeType,
        videoBitsPerSecond: profile.bitrateMbps * 1000 * 1000,
        audioBitsPerSecond: profile.audioBitrateKbps * 1000,
        // This improves the odds that a retained suffix begins near a decodable frame.
        // Blob boundaries are still normalized by the main-process remux on save.
        videoKeyFrameIntervalDuration: CHUNK_MS
      });

      const session = {
        ...capture,
        recorder,
        codec,
        initChunk: null,
        chunks: [],
        startedAt: Date.now(),
        trimmedForSize: false,
        pendingFlush: null
      };

      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data || event.data.size === 0) {
          session.pendingFlush?.resolve();
          return;
        }

        if (!session.initChunk) {
          // First delivery carries the container header the other fragments depend on.
          session.initChunk = event.data;
        } else {
          session.chunks.push({ blob: event.data, at: Date.now() });
          pruneBuffer(session);
        }
        session.pendingFlush?.resolve();
      });

      recorder.addEventListener('error', (event) => {
        console.error(event.error || event);
        RP4.ui.showToast('클립 녹화 중 오류가 발생했습니다.');
      });

      recorder.start(CHUNK_MS);

      state.clip = session;
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
      state.clip = null;
      RP4.app.updateClipUi();
      await RP4.recorder.startPreview();
      RP4.ui.setStatus('클립 모드 실패', '클립 녹화 모드를 시작하지 못했습니다.', 'warn');
      RP4.ui.showToast('클립 녹화 모드를 시작하지 못했습니다.');
    }
  }

  /** Asks the recorder for everything buffered so far and waits for it to arrive. */
  function flush(session) {
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
    if (!session) return;

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
    RP4.app.updateClipUi();
    await RP4.recorder.startPreview();
    RP4.ui.setStatus('준비 완료', '녹화 준비가 완료되었습니다.', 'ready');
  }

  async function saveClip() {
    const session = state.clip;
    if (!session || state.clipSaving) return;

    state.clipSaving = true;
    RP4.app.updateClipUi();
    let clipSession = null;

    try {
      await flush(session);

      const profile = RP4.profile.get();
      const savePoint = Date.now();
      const windowMs = profile.clipDurationSeconds * 1000;
      const cutoff = savePoint - windowMs;

      if (!session.initChunk || session.chunks.length === 0) {
        RP4.ui.showToast('아직 저장할 클립 데이터가 없습니다.');
        return;
      }

      // A chunk delivered at `at` covers roughly the interval ending at `at`.
      let selected = session.chunks.filter((entry) => entry.at > cutoff);
      if (selected.length === 0) {
        selected = session.chunks.slice(-1);
      }

      const firstAt = selected[0].at;
      const lastAt = selected[selected.length - 1].at;
      const estimatedMs = Math.min(windowMs, Math.max(CHUNK_MS, lastAt - firstAt + CHUNK_MS));

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
        clip: true
      };

      // Stream each retained MediaRecorder delivery separately. Building one giant Blob,
      // flattening it to an ArrayBuffer, and cloning it through IPC could otherwise create
      // several simultaneous copies of a hundreds-of-megabytes clip.
      clipSession = await window.rp4.startRecording(meta);
      await window.rp4.writeRecordingChunk({
        sessionId: clipSession.sessionId,
        buffer: await session.initChunk.arrayBuffer()
      });
      for (const entry of selected) {
        await window.rp4.writeRecordingChunk({
          sessionId: clipSession.sessionId,
          buffer: await entry.blob.arrayBuffer()
        });
      }
      const saved = await window.rp4.stopRecording({
        sessionId: clipSession.sessionId,
        durationMs: estimatedMs,
        meta
      });
      clipSession = null;
      if (!saved) throw new Error('클립 저장 결과가 없습니다.');

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
          durationMs: 0
        }).catch(() => {});
      }
      RP4.ui.setStatus('클립 저장 실패', '클립 파일 저장을 완료하지 못했습니다.', 'warn');
      RP4.ui.showToast('클립 파일 저장을 완료하지 못했습니다.');
    } finally {
      state.clipSaving = false;
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
