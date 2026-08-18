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
    const highDetail = source?.type === 'window' || mode === 'area';
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
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: false, video }), systemAudio: false };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
        video
      });
      return { stream, systemAudio: stream.getAudioTracks().length > 0 };
    } catch {
      // Chromium can only attach loopback audio to whole-screen sources, so window capture
      // falls back to video only.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      return { stream, systemAudio: false, systemAudioUnavailable: true };
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
  function createProcessedTrack(videoTrack, { getCrop, output }) {
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

          if (crop.width === output.width && crop.height === output.height) {
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
  async function createCanvasCroppedTrack(videoTrack, { getCrop, output, fps }) {
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

        videoOut = supportsZeroCopyCrop()
          ? createProcessedTrack(videoTrack, { getCrop, output })
          : await createCanvasCroppedTrack(videoTrack, { getCrop, output, fps: profile.fps });
        disposers.push(() => videoOut.stop?.());
      }

      const outputStream = new MediaStream([videoOut.track]);
      const gains = { system: null, mic: null };
      let audioContext = null;

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
        systemAudio: desktop.systemAudio,
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
    const frame = await window.rp4.captureScreenshotSource(source.id);
    const bitmap = await createImageBitmap(new Blob([frame.buffer], { type: 'image/png' }));
    try {
      let crop = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      if (mode === 'area' && snapshot.hasAreaSelection !== false) {
        crop = areaCropFor(bitmap.width, bitmap.height, areaSelection);
      } else if (source.type === 'window') {
        if (frame.clientCrop) crop = windowCropFor(frame.clientCrop, bitmap.width, bitmap.height);
      }

      const canvas = document.createElement('canvas');
      canvas.width = crop.width;
      canvas.height = crop.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

      return canvas;
    } finally {
      bitmap.close();
    }
  }

  RP4.capture = {
    pickRecorderMime,
    supportsZeroCopyCrop,
    createCaptureStream,
    captureStill,
    computeOutputSize
  };
}(window.RP4));
