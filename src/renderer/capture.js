'use strict';

/*
 * Capture pipeline: source streams, cropping, audio mixing and still frames.
 */
(function initCapture(RP4) {
  const { state, els, util } = RP4;

  // Recording used to always produce VP8/WebM and then pay a full libx264 re-encode to
  // reach MP4. Chromium can emit H.264 straight into an MP4 container, so the preferred
  // types below let the recorder write the final file directly - the stop button no longer
  // waits on a conversion. Ordered most to least desirable.
  const MP4_DIRECT = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D0028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4'
  ];
  // Still H.264, wrong container: finishing only needs a stream copy, not a re-encode.
  const MP4_STREAM_COPY = [
    'video/x-matroska;codecs=avc1,opus',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=h264'
  ];
  const WEBM_DIRECT = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  const CROP_POLL_MS = 500;

  function isSupported(mimeType) {
    try {
      return MediaRecorder.isTypeSupported(mimeType);
    } catch {
      return false;
    }
  }

  function firstSupported(list) {
    return list.find(isSupported) || null;
  }

  function describeMime(mimeType) {
    const value = String(mimeType || '').toLowerCase();
    const container = value.includes('video/mp4')
      ? 'mp4'
      : value.includes('x-matroska') ? 'mkv' : 'webm';
    const codec = (value.includes('avc1') || value.includes('h264'))
      ? 'h264'
      : value.includes('vp9') ? 'vp9' : value.includes('vp8') ? 'vp8' : 'unknown';
    return { container, codec };
  }

  /**
   * Chooses the recorder type for a requested output format and reports how the file will
   * be finished so the UI can be honest about it.
   */
  function pickRecorderMime(format) {
    if (format === 'webm') {
      const mimeType = firstSupported(WEBM_DIRECT);
      if (!mimeType) return null;
      return { mimeType, ...describeMime(mimeType), finish: 'direct' };
    }

    const direct = firstSupported(MP4_DIRECT);
    if (direct) {
      return { mimeType: direct, ...describeMime(direct), finish: 'direct' };
    }

    const streamCopy = firstSupported(MP4_STREAM_COPY);
    if (streamCopy) {
      return { mimeType: streamCopy, ...describeMime(streamCopy), finish: 'stream-copy' };
    }

    const fallback = firstSupported(WEBM_DIRECT);
    if (!fallback) return null;
    return { mimeType: fallback, ...describeMime(fallback), finish: 'transcode' };
  }

  function supportsZeroCopyCrop() {
    return typeof window.MediaStreamTrackProcessor === 'function'
      && typeof window.MediaStreamTrackGenerator === 'function'
      && typeof window.VideoFrame === 'function';
  }

  async function getDesktopStream(source, {
    audio,
    mode = state.selectedMode,
    profile = RP4.profile.get()
  }) {
    // Crop modes discard part of the frame, so the source is requested at full detail and
    // the requested resolution is applied to the cropped output instead.
    const highDetail = source?.type === 'window' || mode === 'area' || mode === 'game';
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxWidth: highDetail ? Math.max(profile.width, 3840) : profile.width,
        maxHeight: highDetail ? Math.max(profile.height, 2160) : profile.height,
        maxFrameRate: profile.fps
      }
    };

    if (!audio) {
      return {
        stream: await navigator.mediaDevices.getUserMedia({ audio: false, video }),
        requestedSystemAudio: false,
        hasSystemAudio: false
      };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
        video
      });
      const hasSystemAudio = stream.getAudioTracks().length > 0;
      return {
        stream,
        requestedSystemAudio: true,
        hasSystemAudio,
        systemAudioUnavailable: !hasSystemAudio
      };
    } catch {
      // Chromium can only attach loopback audio to whole-screen sources, so window capture
      // falls back to video only.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      return {
        stream,
        requestedSystemAudio: true,
        hasSystemAudio: false,
        systemAudioUnavailable: true
      };
    }
  }

  function alignRect(rect, frameWidth, frameHeight) {
    const maxWidth = util.makeEvenSize(frameWidth);
    const maxHeight = util.makeEvenSize(frameHeight);

    let width = util.makeEvenSize(util.clamp(rect.width, 2, maxWidth));
    let height = util.makeEvenSize(util.clamp(rect.height, 2, maxHeight));
    // visibleRect offsets must be even too, or chroma planes land on a half sample.
    const x = util.makeEvenOffset(util.clamp(rect.x, 0, maxWidth - width));
    const y = util.makeEvenOffset(util.clamp(rect.y, 0, maxHeight - height));

    if (x + width > frameWidth) width = util.makeEvenSize(frameWidth - x);
    if (y + height > frameHeight) height = util.makeEvenSize(frameHeight - y);

    return { x, y, width: Math.max(2, width), height: Math.max(2, height) };
  }

  function areaCropFor(frameWidth, frameHeight, selection = state.areaSelection) {
    return alignRect({
      x: selection.x * frameWidth,
      y: selection.y * frameHeight,
      width: selection.width * frameWidth,
      height: selection.height * frameHeight
    }, frameWidth, frameHeight);
  }

  function windowCropFor(crop, frameWidth, frameHeight) {
    if (!crop) return alignRect({ x: 0, y: 0, width: frameWidth, height: frameHeight }, frameWidth, frameHeight);
    const scaleX = frameWidth / Math.max(1, crop.frameWidth);
    const scaleY = frameHeight / Math.max(1, crop.frameHeight);
    return alignRect({
      x: crop.x * scaleX,
      y: crop.y * scaleY,
      width: crop.width * scaleX,
      height: crop.height * scaleY
    }, frameWidth, frameHeight);
  }

  /**
   * Keeps the window client rectangle up to date. The old code fetched it once per stream,
   * so moving or resizing the captured window left the crop pointing at the old position.
   * The main-process helper keeps a PowerShell host alive, making this poll cheap.
   */
  function startWindowCropPoller(sourceId, initialCrop) {
    const holder = { crop: initialCrop, stopped: false };

    const tick = async () => {
      if (holder.stopped) return;
      try {
        const next = await window.rp4.getWindowClientCrop(sourceId);
        if (next && !holder.stopped) holder.crop = next;
      } catch {
        // Keep the previous rectangle if a poll fails.
      }
      if (!holder.stopped) {
        holder.timer = window.setTimeout(tick, CROP_POLL_MS);
      }
    };

    holder.timer = window.setTimeout(tick, CROP_POLL_MS);
    holder.stop = () => {
      holder.stopped = true;
      window.clearTimeout(holder.timer);
    };
    return holder;
  }

  /** Output size honouring the requested resolution as an upper bound. */
  function computeOutputSize(cropWidth, cropHeight, profile) {
    if (profile.lossless) {
      return { width: util.makeEven(cropWidth), height: util.makeEven(cropHeight) };
    }
    const scale = Math.min(profile.width / cropWidth, profile.height / cropHeight, 1);
    if (scale >= 1) {
      return { width: util.makeEven(cropWidth), height: util.makeEven(cropHeight) };
    }
    return {
      width: util.makeEven(cropWidth * scale),
      height: util.makeEven(cropHeight * scale)
    };
  }

  /**
   * Crops (and if needed scales) a video track.
   *
   * Uses MediaStreamTrackProcessor so the work is driven by arriving frames rather than by
   * the rendering loop. The previous canvas + requestAnimationFrame implementation stopped
   * producing frames whenever the window was hidden, which broke area and window recording
   * the moment the user alt-tabbed away.
   *
   * The output size is fixed for the lifetime of the track: changing resolution mid-stream
   * would force the H.264 encoder to re-initialise.
   */
  function createFpsOverlay(enabled, intervalMs = 500) {
    let startedAt = performance.now();
    let frames = 0;
    let displayedFps = 0;

    return {
      enabled: Boolean(enabled),
      draw(context, width, height) {
        if (!enabled) return;
        const now = performance.now();
        frames += 1;
        const elapsed = now - startedAt;
        if (elapsed >= intervalMs) {
          displayedFps = Math.max(0, Math.round(frames * 1000 / elapsed));
          frames = 0;
          startedAt = now;
        }

        const fontSize = Math.max(18, Math.round(height * 0.028));
        const label = `${displayedFps || '--'} FPS`;
        context.save();
        context.font = `900 ${fontSize}px PyeojinGothic, sans-serif`;
        context.textBaseline = 'top';
        const paddingX = Math.max(8, Math.round(fontSize * 0.45));
        const paddingY = Math.max(5, Math.round(fontSize * 0.28));
        const boxWidth = Math.ceil(context.measureText(label).width + paddingX * 2);
        const boxHeight = fontSize + paddingY * 2;
        const offset = Math.max(10, Math.round(height * 0.018));
        context.fillStyle = 'rgba(0, 0, 0, 0.72)';
        context.fillRect(offset, offset, boxWidth, boxHeight);
        context.fillStyle = state.isRecording || state.clip ? '#ff3b13' : '#ffd34d';
        context.fillText(label, offset + paddingX, offset + paddingY);
        context.restore();
      }
    };
  }

  function createProcessedTrack(videoTrack, { getCrop, output, fpsOverlay = null }) {
    const processor = new window.MediaStreamTrackProcessor({ track: videoTrack });
    const generator = new window.MediaStreamTrackGenerator({ kind: 'video' });

    let canvas = null;
    let context = null;
    let stopped = false;

    const ensureCanvas = () => {
      if (!canvas) {
        canvas = new OffscreenCanvas(output.width, output.height);
        context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      }
      return context;
    };

    const transformer = new TransformStream({
      transform(frame, controller) {
        if (stopped) {
          frame.close();
          return;
        }

        try {
          const frameWidth = frame.displayWidth || frame.codedWidth;
          const frameHeight = frame.displayHeight || frame.codedHeight;
          const crop = getCrop(frameWidth, frameHeight);

          if (crop.width === output.width && crop.height === output.height && !fpsOverlay?.enabled) {
            // Zero-copy: no pixels are read back or re-drawn.
            controller.enqueue(new window.VideoFrame(frame, {
              visibleRect: crop,
              timestamp: frame.timestamp,
              duration: frame.duration ?? undefined
            }));
          } else {
            const ctx = ensureCanvas();
            const scale = Math.min(output.width / crop.width, output.height / crop.height);
            const drawWidth = Math.max(1, Math.round(crop.width * scale));
            const drawHeight = Math.max(1, Math.round(crop.height * scale));
            const offsetX = Math.round((output.width - drawWidth) / 2);
            const offsetY = Math.round((output.height - drawHeight) / 2);

            if (drawWidth !== output.width || drawHeight !== output.height) {
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, output.width, output.height);
            }
            ctx.drawImage(
              frame,
              crop.x, crop.y, crop.width, crop.height,
              offsetX, offsetY, drawWidth, drawHeight
            );
            fpsOverlay?.draw(ctx, output.width, output.height);

            controller.enqueue(new window.VideoFrame(canvas, {
              timestamp: frame.timestamp,
              duration: frame.duration ?? undefined
            }));
          }
        } catch {
          // Drop the frame rather than tearing the whole pipeline down.
        } finally {
          frame.close();
        }
      }
    });

    processor.readable
      .pipeThrough(transformer)
      .pipeTo(generator.writable)
      .catch(() => {
        // Resolves as a rejection whenever the track ends; nothing to do.
      });

    return {
      track: generator,
      stop: () => {
        stopped = true;
        try {
          generator.stop();
        } catch {
          // already stopped
        }
      }
    };
  }

  /**
   * Fallback crop path for builds without insertable streams. Driven by
   * requestVideoFrameCallback with a timer backstop; `backgroundThrottling` is disabled on
   * the window so neither is throttled when the app is not visible.
   */
  async function createCanvasCroppedTrack(videoTrack, { getCrop, output, fps, fpsOverlay = null }) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    await video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const outputStream = canvas.captureStream(fps);

    let stopped = false;
    let frameHandle = 0;
    let timerHandle = 0;

    const draw = () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const crop = getCrop(video.videoWidth, video.videoHeight);
        const scale = Math.min(output.width / crop.width, output.height / crop.height);
        const drawWidth = Math.max(1, Math.round(crop.width * scale));
        const drawHeight = Math.max(1, Math.round(crop.height * scale));
        const offsetX = Math.round((output.width - drawWidth) / 2);
        const offsetY = Math.round((output.height - drawHeight) / 2);

        if (drawWidth !== output.width || drawHeight !== output.height) {
          context.fillStyle = '#000';
          context.fillRect(0, 0, output.width, output.height);
        }
        context.drawImage(
          video,
          crop.x, crop.y, crop.width, crop.height,
          offsetX, offsetY, drawWidth, drawHeight
        );
        fpsOverlay?.draw(context, output.width, output.height);
      }
      schedule();
    };

    const schedule = () => {
      if (stopped) return;
      if (video.requestVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback(draw);
      } else {
        timerHandle = window.setTimeout(draw, Math.max(4, Math.round(1000 / fps)));
      }
    };
    schedule();

    return {
      track: outputStream.getVideoTracks()[0],
      stop: () => {
        stopped = true;
        if (video.cancelVideoFrameCallback && frameHandle) video.cancelVideoFrameCallback(frameHandle);
        window.clearTimeout(timerHandle);
        video.pause();
        video.srcObject = null;
        util.stopStream(outputStream);
      }
    };
  }

  function waitForTrackDimensions(track, timeoutMs = 5000) {
    const settings = track.getSettings?.() || {};
    if (settings.width && settings.height) return Promise.resolve(settings);

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const current = track.getSettings?.() || {};
        if (current.width && current.height) {
          resolve(current);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('영상 정보를 읽는 시간이 초과되었습니다.'));
          return;
        }
        window.setTimeout(poll, 50);
      };
      poll();
    });
  }

  /**
   * Builds the stream handed to MediaRecorder (or to the preview element).
   *
   * @returns {Promise<object>} handle with `stream`, `cleanup`, `gains` and `output`
   */
  async function createCaptureStream({
    audio,
    cropArea,
    includeMic,
    source = state.selectedSource,
    mode = state.selectedMode,
    areaSelection = state.areaSelection,
    profile = RP4.profile.get()
  }) {
    if (!source) throw new Error('캡처 소스가 없습니다.');

    const desktop = await getDesktopStream(source, { audio, mode, profile });
    const inputs = [desktop.stream];
    const disposers = [];

    try {
      const videoTrack = desktop.stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('영상 트랙을 찾을 수 없습니다.');
      videoTrack.contentHint = 'motion';

      const wantsAreaCrop = Boolean(cropArea && mode === 'area');
      const wantsWindowCrop = source.type === 'window' && !wantsAreaCrop;

      const settings = await waitForTrackDimensions(videoTrack);
      const frameWidth = settings.width;
      const frameHeight = settings.height;

      let videoOut = { track: videoTrack, stop: null };
      let output = { width: util.makeEven(frameWidth), height: util.makeEven(frameHeight) };
      let cropPoller = null;

      if (wantsAreaCrop || wantsWindowCrop) {
        let getCrop;

        if (wantsAreaCrop) {
          getCrop = (width, height) => areaCropFor(width, height, areaSelection);
        } else {
          const initialCrop = await window.rp4.getWindowClientCrop(source.id);
          if (!initialCrop) {
            RP4.ui.showToast('창 내부 영역을 찾지 못해 창 전체를 사용합니다.');
          }
          cropPoller = startWindowCropPoller(source.id, initialCrop);
          disposers.push(() => cropPoller.stop());
          getCrop = (width, height) => windowCropFor(cropPoller.crop, width, height);
        }

        const initialRect = getCrop(frameWidth, frameHeight);
        output = computeOutputSize(initialRect.width, initialRect.height, profile);
        const fpsOverlay = createFpsOverlay(
          mode === 'game' && state.appSettings.gameFpsOverlay,
          state.appSettings.gameFpsIntervalMs
        );

        videoOut = supportsZeroCopyCrop()
          ? createProcessedTrack(videoTrack, { getCrop, output, fpsOverlay })
          : await createCanvasCroppedTrack(videoTrack, {
              getCrop,
              output,
              fps: profile.fps,
              fpsOverlay
            });
        disposers.push(() => videoOut.stop?.());
      }

      const outputStream = new MediaStream([videoOut.track]);
      const gains = { system: null, mic: null };
      let audioContext = null;
      let hasMic = false;

      const audioSources = [];
      if (audio && desktop.stream.getAudioTracks().length > 0) {
        audioSources.push({
          key: 'system',
          stream: new MediaStream(desktop.stream.getAudioTracks()),
          gain: Number(els.systemVolume.value) / 100
        });
      }

      if (includeMic) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false }
          });
          inputs.push(micStream);
          hasMic = micStream.getAudioTracks().length > 0;
          audioSources.push({
            key: 'mic',
            stream: micStream,
            gain: Number(els.micVolume.value) / 100
          });
        } catch {
          RP4.ui.showToast('마이크를 열 수 없어 마이크 없이 녹화합니다.');
        }
      }

      if (audioSources.length > 0) {
        audioContext = new AudioContext();
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        if (audioContext.state !== 'running') {
          throw new Error('오디오 처리기를 시작할 수 없습니다. 창을 한 번 클릭한 뒤 다시 시도해 주세요.');
        }
        const destination = audioContext.createMediaStreamDestination();

        for (const entry of audioSources) {
          const node = audioContext.createMediaStreamSource(entry.stream);
          const gainNode = audioContext.createGain();
          gainNode.gain.value = entry.gain;
          node.connect(gainNode).connect(destination);
          // Retained so the sliders can adjust levels while recording. Previously the gain
          // was read once and dragging a slider mid-recording did nothing.
          gains[entry.key] = gainNode;
        }

        for (const track of destination.stream.getAudioTracks()) {
          outputStream.addTrack(track);
        }
      }

      return {
        stream: outputStream,
        output,
        captureBackend: mode === 'game' ? 'windows-graphics-capture' : 'desktop-capture',
        requestedSystemAudio: Boolean(desktop.requestedSystemAudio),
        hasSystemAudio: Boolean(desktop.hasSystemAudio),
        requestedMic: Boolean(includeMic),
        hasMic,
        systemAudio: Boolean(desktop.hasSystemAudio),
        systemAudioUnavailable: Boolean(desktop.systemAudioUnavailable),
        gains,
        audioContext,
        cleanup: () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              // best effort
            }
          }
          util.stopStream(outputStream);
          for (const stream of inputs) {
            util.stopStream(stream);
          }
          if (audioContext) {
            audioContext.close().catch(() => {});
          }
        }
      };
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // best effort
        }
      }
      for (const stream of inputs) {
        util.stopStream(stream);
      }
      throw error;
    }
  }

  function notifyAudioStatus(capture) {
    if (capture.requestedSystemAudio && !capture.hasSystemAudio) {
      RP4.ui.showToast(capture.hasMic
        ? '이 소스에서는 시스템 오디오를 사용할 수 없어 마이크만 녹음합니다.'
        : '이 소스에서는 시스템 오디오를 사용할 수 없어 오디오 없이 녹화합니다.');
    }
  }

  async function detectEncodingAcceleration(profile, mimeType) {
    if (!navigator.mediaCapabilities?.encodingInfo || !mimeType) {
      return { supported: Boolean(mimeType), powerEfficient: null, smooth: null };
    }
    const lower = String(mimeType).toLowerCase();
    const codec = lower.includes('avc1') || lower.includes('h264')
      ? 'avc1.640028'
      : lower.includes('vp9') ? 'vp9' : lower.includes('vp8') ? 'vp8' : null;
    const container = lower.includes('mp4') ? 'video/mp4' : 'video/webm';
    const contentType = codec ? `${container};codecs="${codec}"` : container;
    try {
      const result = await navigator.mediaCapabilities.encodingInfo({
        type: 'record',
        video: {
          contentType,
          width: Math.max(2, Number(profile.width) || 1920),
          height: Math.max(2, Number(profile.height) || 1080),
          bitrate: Math.max(100000, Number(profile.bitrateMbps) * 1000 * 1000 || 10000000),
          framerate: Math.max(1, Number(profile.fps) || 60)
        }
      });
      return {
        supported: result.supported === true,
        powerEfficient: typeof result.powerEfficient === 'boolean' ? result.powerEfficient : null,
        smooth: typeof result.smooth === 'boolean' ? result.smooth : null
      };
    } catch {
      return { supported: true, powerEfficient: null, smooth: null };
    }
  }

  /**
   * Grabs a single full-resolution frame from a fresh capture.
   *
   * Screenshots used to be copied out of the preview <video>, which meant they were capped
   * at preview resolution and could be stale or black when the window was minimized -
   * precisely when the screenshot hotkey is most useful.
   */
  async function captureStill(snapshot = {}) {
    const source = snapshot.source || state.selectedSource;
    const mode = snapshot.mode || state.selectedMode;
    const areaSelection = snapshot.areaSelection || state.areaSelection;
    if (!source) throw new Error('캡처 소스가 없습니다.');
    const frame = await window.rp4.captureScreenshotSource({
      sourceId: source.id,
      mode,
      areaSelection,
      hasAreaSelection: snapshot.hasAreaSelection
    });
    const bitmap = await createImageBitmap(new Blob([frame.buffer], { type: 'image/png' }));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);

      return canvas;
    } finally {
      bitmap.close();
    }
  }

  RP4.capture = {
    pickRecorderMime,
    supportsZeroCopyCrop,
    createCaptureStream,
    detectEncodingAcceleration,
    notifyAudioStatus,
    captureStill,
    computeOutputSize
  };
}(window.RP4));
