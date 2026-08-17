(() => {
  if (globalThis.__AEGIS_YOUTUBE_ADSHIELD__) return;
  globalThis.__AEGIS_YOUTUBE_ADSHIELD__ = true;

  const PROMO_SELECTORS = [
    "ytd-display-ad-renderer", "ytd-ad-slot-renderer", "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-sparkles-web-renderer", "ytd-promoted-video-renderer",
    "ytd-action-companion-ad-renderer", "ytd-banner-promo-renderer",
    "ytd-mealbar-promo-renderer", "ytd-statement-banner-renderer",
    "#player-ads", "#masthead-ad", ".ytp-ad-overlay-container",
    ".ytp-ad-player-overlay", ".ytp-ad-message-container"
  ];
  const SKIP_SELECTORS = [
    ".ytp-ad-skip-button-modern", ".ytp-ad-skip-button", ".ytp-skip-ad-button",
    "button.ytp-ad-skip-button", "button[class*='ytp-ad-skip']"
  ];
  const DETECTION_TEXT = /(?:ad\s*blockers?\s+(?:are\s+not\s+allowed|violate)|video\s+playback\s+is\s+blocked|allow\s+youtube\s+ads|disable\s+(?:your\s+)?ad\s*blocker)/i;

  let config = null;
  let mode = "network";
  let detectionSent = false;
  let adActive = false;
  let handledThisAd = false;
  let savedVideoState = null;
  let observer = null;
  let timer = null;

  function toast(text) {
    if (document.getElementById("aegis-youtube-toast")) return;
    const box = document.createElement("div");
    box.id = "aegis-youtube-toast";
    box.setAttribute("role", "status");
    box.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:11px 13px;border:1px solid #365268;border-radius:10px;background:#101722;color:#edf4ff;font:13px system-ui;box-shadow:0 8px 26px rgba(0,0,0,.38)";
    box.textContent = text;
    (document.documentElement || document).appendChild(box);
    setTimeout(() => box.remove(), 5000);
  }

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 260 && rect.height > 100;
  }

  async function detectAntiAdblock() {
    if (detectionSent || !config?.adblock?.youtube?.autoFallback) return;
    const candidates = document.querySelectorAll("ytd-enforcement-message-view-model, tp-yt-paper-dialog, [role='dialog'], ytd-popup-container");
    for (const element of candidates) {
      if (!visible(element)) continue;
      const text = (element.innerText || element.textContent || "").slice(0, 2200);
      if (!DETECTION_TEXT.test(text)) continue;
      detectionSent = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: "YOUTUBE_ANTI_ADBLOCK_DETECTED" });
        if (response?.bypassed) {
          toast("Aegis detected YouTube's anti-adblock wall. YouTube filtering is paused for this tab; reloading through the temporary bypass.");
          if (response.reload) setTimeout(() => location.reload(), 650);
        }
      } catch { /* extension may be reloading */ }
      break;
    }
  }

  function hidePromotions(root = document) {
    if (!config?.adblock?.youtube?.hidePromotions) return;
    for (const selector of PROMO_SELECTORS) {
      for (const element of root.querySelectorAll?.(selector) || []) {
        if (!(element instanceof HTMLElement)) continue;
        element.style.setProperty("display", "none", "important");
        element.setAttribute("aria-hidden", "true");
      }
    }
  }

  function clickSkip() {
    for (const selector of SKIP_SELECTORS) {
      const button = document.querySelector(selector);
      if (button instanceof HTMLElement && visible(button)) {
        button.click();
        return true;
      }
    }
    return false;
  }

  function rememberVideo(video) {
    if (savedVideoState?.video === video) return;
    savedVideoState = {
      video,
      muted: video.muted,
      volume: video.volume,
      playbackRate: video.playbackRate
    };
  }

  function restoreVideo() {
    const state = savedVideoState;
    savedVideoState = null;
    if (!state?.video?.isConnected) return;
    try {
      state.video.muted = state.muted;
      state.video.volume = state.volume;
      state.video.playbackRate = state.playbackRate;
    } catch { /* player replaced the element */ }
  }

  function handlePlayerAd() {
    const player = document.querySelector(".html5-video-player");
    const video = player?.querySelector("video.html5-main-video, video");
    const showing = Boolean(player?.classList.contains("ad-showing") || document.querySelector(".ytp-ad-player-overlay, .ytp-ad-text"));

    if (!showing) {
      if (adActive) restoreVideo();
      adActive = false;
      handledThisAd = false;
      return;
    }

    adActive = true;
    clickSkip();
    if (video instanceof HTMLVideoElement) {
      rememberVideo(video);
      video.muted = true;
      if (mode === "aggressive") {
        video.playbackRate = 16;
        if (Number.isFinite(video.duration) && video.duration > 0.25) {
          try { video.currentTime = Math.max(video.currentTime, video.duration - 0.12); } catch { /* non-seekable ad */ }
        }
      }
    }

    if (!handledThisAd) {
      handledThisAd = true;
      chrome.runtime.sendMessage({ type: "YOUTUBE_AD_HANDLED", count: 1 }).catch(() => {});
    }
  }

  function process(root = document) {
    hidePromotions(root);
    handlePlayerAd();
    detectAntiAdblock();
  }

  chrome.runtime.sendMessage({ type: "GET_STATE" }).then(response => {
    config = response?.config;
    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    const allowed = (config?.adblock?.allowlist || []).some(domain => host === domain || host.endsWith(`.${domain}`));
    if (!config?.adblock?.enabled || !config.adblock.youtube?.enabled || response?.youtubeBypassed || allowed) return;
    mode = config.adblock.youtube.mode;
    if (mode === "network") return;

    const style = document.createElement("style");
    style.id = "aegis-youtube-adshield-style";
    style.textContent = `${PROMO_SELECTORS.join(",")} { display:none !important; visibility:hidden !important; }`;
    (document.documentElement || document).appendChild(style);

    process(document);
    observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) process(node);
        }
      }
      handlePlayerAd();
      detectAntiAdblock();
    });
    observer.observe(document, { subtree: true, childList: true });
    timer = setInterval(() => process(document), mode === "aggressive" ? 350 : 800);
    document.addEventListener("yt-navigate-finish", () => process(document));
    window.addEventListener("pagehide", () => {
      restoreVideo();
      observer?.disconnect();
      clearInterval(timer);
    }, { once: true });
  }).catch(() => {});
})();
