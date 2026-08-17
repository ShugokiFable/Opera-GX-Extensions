(() => {
  'use strict';

  if (globalThis.__PRISMSHOT_GX_LOADED__) return;
  globalThis.__PRISMSHOT_GX_LOADED__ = true;

  const CHANNEL = `__PRISMSHOT_GX_FRAME_${chrome.runtime.id}__`;
  const videoIds = new WeakMap();
  const knownVideos = new Set();
  const observedRoots = new WeakSet();
  const videosById = new Map();
  const lastInteraction = new WeakMap();
  const fpsTrackers = new WeakMap();
  const pendingTransforms = new Map();
  const visibleRestore = new Map();

  let overlayEnabled = true;
  let captureUiHidden = false;
  let overlayHost = null;
  let overlayShadow = null;
  let overlayVideo = null;
  let overlayTimer = null;
  let videoSequence = 0;

  init();

  async function init() {
    const stored = await chrome.storage.sync.get('settings').catch(() => ({}));
    overlayEnabled = stored.settings?.overlayEnabled !== false;

    window.addEventListener('message', handleFrameMessage, false);
    document.addEventListener('pointerover', noteInteraction, true);
    document.addEventListener('pointerdown', noteInteraction, true);
    document.addEventListener('contextmenu', noteInteraction, true);
    document.addEventListener('play', noteInteraction, true);
    document.addEventListener('volumechange', noteInteraction, true);
    document.addEventListener('fullscreenchange', scheduleOverlayUpdate, true);
    window.addEventListener('scroll', scheduleOverlayUpdate, { passive: true, capture: true });
    window.addEventListener('resize', scheduleOverlayUpdate, { passive: true });

    observeRoot(document);
    scanNode(document);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings) {
        overlayEnabled = changes.settings.newValue?.overlayEnabled !== false;
        scheduleOverlayUpdate();
      }
    });

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    updateOverlay();
    overlayTimer = window.setInterval(updateOverlay, 900);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== 'object') return undefined;

    if (message.type === 'PRISMSHOT_PROBE') {
      probeVideos().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'PRISMSHOT_CAPTURE_NATIVE') {
      captureNative(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'PRISMSHOT_PREPARE_VISIBLE') {
      prepareVisible(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'PRISMSHOT_RESTORE_VISIBLE') {
      restoreVisible(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'PRISMSHOT_STEP_VIDEO') {
      stepVideo(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'PRISMSHOT_CAPTURE_VISIBILITY') {
      captureUiHidden = Boolean(message.hidden);
      updateOverlay();
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'PRISMSHOT_OVERLAY_SETTING') {
      overlayEnabled = Boolean(message.enabled);
      updateOverlay();
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'PRISMSHOT_TOAST') {
      showToast(message.message, message.tone || 'neutral');
      sendResponse({ ok: true });
      return undefined;
    }

    return undefined;
  }

  async function probeVideos() {
    const transform = await getTransformToTop().catch(() => ({
      x: 0,
      y: 0,
      sx: 1,
      sy: 1,
      topWidth: window.innerWidth,
      topHeight: window.innerHeight,
      degraded: window !== window.top
    }));

    const videos = collectVideos().map((video) => describeVideo(video, transform));
    return {
      ok: true,
      videos,
      frameTitle: document.title || '',
      frameUrl: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      topViewport: {
        width: transform.topWidth || window.innerWidth,
        height: transform.topHeight || window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    };
  }

  function describeVideo(video, transform) {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    const topRect = {
      left: transform.x + rect.left * transform.sx,
      top: transform.y + rect.top * transform.sy,
      width: rect.width * transform.sx,
      height: rect.height * transform.sy
    };

    const topWidth = transform.topWidth || window.innerWidth;
    const topHeight = transform.topHeight || window.innerHeight;
    const intersectionWidth = Math.max(0, Math.min(topWidth, topRect.left + topRect.width) - Math.max(0, topRect.left));
    const intersectionHeight = Math.max(0, Math.min(topHeight, topRect.top + topRect.height) - Math.max(0, topRect.top));
    const visibleArea = intersectionWidth * intersectionHeight;
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && visibleArea > 64;
    const source = video.currentSrc || video.src || '';

    return {
      videoId: getVideoId(video),
      topRect,
      localRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      area: Math.max(0, rect.width * rect.height),
      visibleArea,
      visible,
      videoWidth: video.videoWidth || 0,
      videoHeight: video.videoHeight || 0,
      currentTime: finite(video.currentTime),
      duration: finite(video.duration),
      paused: video.paused,
      muted: video.muted,
      readyState: video.readyState,
      networkState: video.networkState,
      playbackRate: video.playbackRate,
      hasCaptions: Array.from(video.textTracks || []).some((track) => track.mode === 'showing') || (video.textTracks?.length || 0) > 0,
      sourceHost: hostname(source),
      canvasLikelySafe: isCanvasLikelySafe(source),
      lastInteraction: lastInteraction.get(video) || 0,
      degradedCoordinates: Boolean(transform.degraded)
    };
  }

  async function captureNative(message) {
    const video = findVideo(message.videoId);
    if (!video) return { ok: false, error: 'The selected video element no longer exists.' };
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return { ok: false, error: 'The video has not decoded a frame yet.' };
    }

    const wasPlaying = !video.paused && !video.ended;
    if (message.pauseDuringCapture && wasPlaying) video.pause();

    try {
      await nextPaint();
      const dimensions = safeCanvasDimensions(video.videoWidth, video.videoHeight);
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!context) throw new Error('The browser could not create a capture canvas.');

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(video, 0, 0, dimensions.width, dimensions.height);

      let dataUrl;
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (error) {
        if (error?.name === 'SecurityError') {
          return { ok: false, error: 'This cross-origin player blocks clean source-frame extraction.' };
        }
        throw error;
      }

      return {
        ok: true,
        dataUrl,
        width: dimensions.width,
        height: dimensions.height,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        currentTime: finite(video.currentTime),
        scaledForCanvasLimit: dimensions.scale < 1
      };
    } finally {
      if (message.resumeAfterCapture && wasPlaying) {
        video.play().catch(() => undefined);
      }
    }
  }

  async function prepareVisible(message) {
    const video = findVideo(message.videoId);
    if (!video) return { ok: false, error: 'The selected video element no longer exists.' };

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const wasPlaying = !video.paused && !video.ended;
    visibleRestore.set(token, { video, wasPlaying });

    if (message.pauseDuringCapture && wasPlaying) video.pause();
    captureUiHidden = true;
    updateOverlay();
    await nextPaint();

    return { ok: true, restoreToken: token, currentTime: finite(video.currentTime) };
  }

  async function restoreVisible(message) {
    const state = message.restoreToken ? visibleRestore.get(message.restoreToken) : null;
    if (message.restoreToken) visibleRestore.delete(message.restoreToken);
    captureUiHidden = false;
    updateOverlay();

    if (state?.video?.isConnected && state.wasPlaying && message.resumeAfterCapture) {
      await state.video.play().catch(() => undefined);
    }
    return { ok: true };
  }

  async function stepVideo(message) {
    const video = findVideo(message.videoId);
    if (!video) return { ok: false, error: 'The selected video element no longer exists.' };
    if (!Number.isFinite(video.duration) || video.readyState < 1) {
      return { ok: false, error: 'This stream does not expose a seekable timeline.' };
    }

    video.pause();
    const fps = getEstimatedFps(video);
    const delta = (message.direction < 0 ? -1 : 1) / fps;
    const nextTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
    video.currentTime = nextTime;
    await waitForSeek(video, 900);
    noteVideo(video);
    updateOverlay();

    return { ok: true, currentTime: finite(video.currentTime), fps };
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    const observer = new MutationObserver((mutations) => {
      let changed = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          scanNode(node);
          changed = true;
        }
      }
      if (changed) scheduleOverlayUpdate();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function scanNode(node) {
    if (!node) return;
    if (node instanceof HTMLVideoElement) knownVideos.add(node);
    if (!node.querySelectorAll) return;

    for (const video of node.querySelectorAll('video')) knownVideos.add(video);
    const elements = node instanceof Element ? [node, ...node.querySelectorAll('*')] : node.querySelectorAll('*');
    for (const element of elements) {
      if (element.shadowRoot) {
        observeRoot(element.shadowRoot);
        scanNode(element.shadowRoot);
      }
    }
  }

  function collectVideos(root = document) {
    if (root !== document) scanNode(root);
    for (const video of knownVideos) {
      if (!video.isConnected) knownVideos.delete(video);
    }
    return Array.from(knownVideos);
  }

  function getVideoId(video) {
    let id = videoIds.get(video);
    if (!id) {
      id = `v${Date.now().toString(36)}-${(++videoSequence).toString(36)}`;
      videoIds.set(video, id);
      videosById.set(id, new WeakRef(video));
      startFpsTracker(video);
    }
    return id;
  }

  function findVideo(id) {
    const known = videosById.get(id)?.deref();
    if (known?.isConnected) return known;
    for (const video of collectVideos()) {
      if (getVideoId(video) === id) return video;
    }
    return null;
  }

  function noteInteraction(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const video = path.find((node) => node instanceof HTMLVideoElement) || (event.target instanceof HTMLVideoElement ? event.target : null);
    if (video) noteVideo(video);
  }

  function noteVideo(video) {
    lastInteraction.set(video, Date.now());
    overlayVideo = video;
    scheduleOverlayUpdate();
  }

  function startFpsTracker(video) {
    if (fpsTrackers.has(video) || typeof video.requestVideoFrameCallback !== 'function') return;
    const tracker = { fps: 30, lastMediaTime: null, lastFrames: null, callbackId: null };
    fpsTrackers.set(video, tracker);

    const onFrame = (_now, metadata) => {
      const mediaTime = Number(metadata.mediaTime);
      const presentedFrames = Number(metadata.presentedFrames);
      if (Number.isFinite(mediaTime) && Number.isFinite(presentedFrames) && tracker.lastMediaTime != null) {
        const dt = mediaTime - tracker.lastMediaTime;
        const df = presentedFrames - tracker.lastFrames;
        if (dt > 0.01 && df > 0) {
          const measured = df / dt;
          if (measured >= 8 && measured <= 240) tracker.fps = tracker.fps * 0.75 + measured * 0.25;
        }
      }
      tracker.lastMediaTime = mediaTime;
      tracker.lastFrames = presentedFrames;
      if (video.isConnected) tracker.callbackId = video.requestVideoFrameCallback(onFrame);
    };

    tracker.callbackId = video.requestVideoFrameCallback(onFrame);
  }

  function getEstimatedFps(video) {
    const fps = fpsTrackers.get(video)?.fps || 30;
    return Math.min(120, Math.max(12, fps));
  }

  async function getTransformToTop() {
    if (window === window.top) {
      return { x: 0, y: 0, sx: 1, sy: 1, topWidth: window.innerWidth, topHeight: window.innerHeight };
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const promise = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingTransforms.delete(token);
        reject(new Error('Frame transform request timed out.'));
      }, 700);
      pendingTransforms.set(token, { resolve, timeout });
    });

    window.parent.postMessage({ channel: CHANNEL, type: 'transform-request', token }, '*');
    return promise;
  }

  async function handleFrameMessage(event) {
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.type === 'transform-response' && event.source === window.parent) {
      const pending = pendingTransforms.get(data.token);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingTransforms.delete(data.token);
      pending.resolve(data.transform);
      return;
    }

    if (data.type === 'transform-request') {
      const frame = findChildFrame(event.source);
      if (!frame) return;

      try {
        const own = await getTransformToTop();
        const rect = frame.getBoundingClientRect();
        const layoutWidth = frame.offsetWidth || rect.width || 1;
        const layoutHeight = frame.offsetHeight || rect.height || 1;
        const localScaleX = rect.width / layoutWidth;
        const localScaleY = rect.height / layoutHeight;
        const contentLeft = rect.left + (frame.clientLeft || 0) * localScaleX;
        const contentTop = rect.top + (frame.clientTop || 0) * localScaleY;

        event.source.postMessage({
          channel: CHANNEL,
          type: 'transform-response',
          token: data.token,
          transform: {
            x: own.x + contentLeft * own.sx,
            y: own.y + contentTop * own.sy,
            sx: own.sx * localScaleX,
            sy: own.sy * localScaleY,
            topWidth: own.topWidth,
            topHeight: own.topHeight
          }
        }, '*');
      } catch {
        event.source.postMessage({
          channel: CHANNEL,
          type: 'transform-response',
          token: data.token,
          transform: {
            x: 0,
            y: 0,
            sx: 1,
            sy: 1,
            topWidth: window.innerWidth,
            topHeight: window.innerHeight,
            degraded: true
          }
        }, '*');
      }
    }
  }

  function findChildFrame(sourceWindow) {
    for (const frame of document.querySelectorAll('iframe, frame')) {
      try {
        if (frame.contentWindow === sourceWindow) return frame;
      } catch {
        // Ignore inaccessible frame handles.
      }
    }
    return null;
  }

  function scheduleOverlayUpdate() {
    if (scheduleOverlayUpdate.pending) return;
    scheduleOverlayUpdate.pending = true;
    requestAnimationFrame(() => {
      scheduleOverlayUpdate.pending = false;
      updateOverlay();
    });
  }

  function updateOverlay() {
    if (!overlayEnabled || captureUiHidden || document.fullscreenElement) {
      if (overlayHost) overlayHost.style.display = 'none';
      return;
    }

    const videos = collectVideos().filter(isLocallyVisible);
    if (!videos.length) {
      if (overlayHost) overlayHost.style.display = 'none';
      return;
    }

    const best = chooseLocalVideo(videos);
    if (!best) return;
    overlayVideo = best;
    ensureOverlay();

    const rect = best.getBoundingClientRect();
    const width = 224;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width - 10));
    const top = Math.max(8, Math.min(window.innerHeight - 44, rect.top + 10));
    overlayHost.style.display = 'block';
    overlayHost.style.left = `${Math.round(left)}px`;
    overlayHost.style.top = `${Math.round(top)}px`;

    const label = overlayShadow.querySelector('[data-role="meta"]');
    if (label) {
      const dimensions = best.videoWidth && best.videoHeight ? `${best.videoWidth}×${best.videoHeight}` : 'loading';
      label.textContent = `${dimensions} · ${formatClock(best.currentTime)}`;
    }
  }

  function chooseLocalVideo(videos) {
    return videos.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      const aScore = (a === overlayVideo ? 1e12 : 0) + (!a.paused ? 1e11 : 0) + aRect.width * aRect.height + (lastInteraction.get(a) || 0);
      const bScore = (b === overlayVideo ? 1e12 : 0) + (!b.paused ? 1e11 : 0) + bRect.width * bRect.height + (lastInteraction.get(b) || 0);
      return bScore - aScore;
    })[0];
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected) return;

    overlayHost = document.createElement('div');
    overlayHost.id = `prismshot-gx-${Math.random().toString(36).slice(2)}`;
    Object.assign(overlayHost.style, {
      position: 'fixed',
      zIndex: '2147483647',
      width: '224px',
      height: '38px',
      pointerEvents: 'auto',
      display: 'none'
    });

    overlayShadow = overlayHost.attachShadow({ mode: 'closed' });
    overlayShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          box-sizing: border-box;
          display: grid;
          grid-template-columns: 1fr auto auto auto auto;
          align-items: center;
          gap: 4px;
          height: 38px;
          padding: 4px 5px 4px 10px;
          color: #f7f7fb;
          background: linear-gradient(135deg, rgba(13, 14, 22, .96), rgba(25, 10, 25, .94));
          border: 1px solid rgba(255, 55, 129, .55);
          border-radius: 11px;
          box-shadow: 0 10px 35px rgba(0, 0, 0, .48), 0 0 22px rgba(255, 29, 112, .18);
          backdrop-filter: blur(15px) saturate(1.2);
          font: 600 10px/1.2 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: .02em;
          user-select: none;
        }
        .meta { min-width: 0; color: #b9b9c8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        button {
          all: unset;
          box-sizing: border-box;
          display: grid;
          place-items: center;
          width: 29px;
          height: 28px;
          border-radius: 8px;
          cursor: pointer;
          color: #dedee8;
          background: rgba(255,255,255,.055);
          border: 1px solid rgba(255,255,255,.07);
          transition: transform .12s ease, background .12s ease, border-color .12s ease;
        }
        button:hover { transform: translateY(-1px); background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.17); }
        button:active { transform: translateY(0) scale(.95); }
        button.primary { color: white; background: linear-gradient(135deg, #ff1d70, #9e35ff); border-color: rgba(255,255,255,.2); }
        svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
        .toast {
          position: absolute;
          right: 0;
          top: 44px;
          max-width: 280px;
          padding: 9px 11px;
          color: #f6f6fb;
          background: rgba(12, 13, 20, .97);
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 9px;
          box-shadow: 0 8px 30px rgba(0,0,0,.45);
          opacity: 0;
          transform: translateY(-5px);
          pointer-events: none;
          transition: .18s ease;
          font: 600 11px/1.25 ui-sans-serif, system-ui, sans-serif;
        }
        .toast.show { opacity: 1; transform: translateY(0); }
        .toast.success { border-color: rgba(58, 255, 178, .4); }
        .toast.error { border-color: rgba(255, 76, 103, .55); }
      </style>
      <div class="bar">
        <div class="meta" data-role="meta">PrismShot GX</div>
        <button data-action="back" title="Previous frame">
          <svg viewBox="0 0 24 24"><path d="M11 7 6 12l5 5"/><path d="M18 7 13 12l5 5"/></svg>
        </button>
        <button data-action="forward" title="Next frame">
          <svg viewBox="0 0 24 24"><path d="m6 7 5 5-5 5"/><path d="m13 7 5 5-5 5"/></svg>
        </button>
        <button data-action="copy" title="Copy frame">
          <svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
        </button>
        <button class="primary" data-action="capture" title="Save frame">
          <svg viewBox="0 0 24 24"><path d="M4 8a2 2 0 0 1 2-2h2l1.2-2h5.6L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.2"/></svg>
        </button>
      </div>
      <div class="toast" data-role="toast"></div>
    `;

    overlayShadow.addEventListener('pointerdown', (event) => event.stopPropagation());
    overlayShadow.addEventListener('click', handleOverlayClick);
    (document.documentElement || document.body).appendChild(overlayHost);
  }

  async function handleOverlayClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || !overlayVideo) return;
    event.preventDefault();
    event.stopPropagation();

    const action = button.dataset.action;
    const videoId = getVideoId(overlayVideo);

    if (action === 'back' || action === 'forward') {
      const response = await chrome.runtime.sendMessage({
        type: 'PRISMSHOT_STEP_REQUEST',
        videoId,
        direction: action === 'back' ? -1 : 1
      }).catch((error) => ({ ok: false, error: error.message }));
      if (!response?.ok) showToast(response?.error || 'Frame step failed.', 'error');
      return;
    }

    button.disabled = true;
    const response = await chrome.runtime.sendMessage({
      type: 'PRISMSHOT_CAPTURE_REQUEST',
      videoId,
      destination: action === 'copy' ? 'clipboard' : 'download',
      trigger: 'overlay'
    }).catch((error) => ({ ok: false, error: error.message }));
    button.disabled = false;

    if (!response?.ok) showToast(response?.error || 'Capture failed.', 'error');
  }

  function showToast(message, tone = 'neutral') {
    ensureOverlay();
    const toast = overlayShadow.querySelector('[data-role="toast"]');
    if (!toast) return;
    toast.textContent = String(message || 'Done');
    toast.className = `toast ${tone} show`;
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => {
      toast.className = `toast ${tone}`;
    }, 2600);
  }

  function isLocallyVisible(video) {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    const width = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && width * height > 1600;
  }

  function safeCanvasDimensions(width, height) {
    const maxDimension = 8192;
    const maxPixels = 40_000_000;
    let scale = Math.min(1, maxDimension / width, maxDimension / height, Math.sqrt(maxPixels / (width * height)));
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale
    };
  }

  function isCanvasLikelySafe(source) {
    if (!source || source.startsWith('blob:') || source.startsWith('data:')) return true;
    try {
      return new URL(source, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function hostname(source) {
    try {
      return new URL(source, location.href).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function finite(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function formatClock(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function waitForSeek(video, timeoutMs) {
    return new Promise((resolve) => {
      if (!video.seeking) {
        requestAnimationFrame(resolve);
        return;
      }
      const timeout = setTimeout(done, timeoutMs);
      video.addEventListener('seeked', done, { once: true });
      function done() {
        clearTimeout(timeout);
        resolve();
      }
    });
  }
})();
