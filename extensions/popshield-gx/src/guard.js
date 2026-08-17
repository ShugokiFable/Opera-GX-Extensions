'use strict';

// Isolated world. Bridges settings into the MAIN-world hook, counts blocks, and
// handles the visual half of the problem: overlays that cover the page and the
// scroll locks that come with them.
(() => {
  const OVERLAY_MARK = 'data-popshield-overlay';
  let settings = null;

  function pushConfig() {
    document.dispatchEvent(new CustomEvent('popshield:config', { detail: settings }));
  }

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PS_GET_SETTINGS' });
      settings = response?.settings || null;
      if (settings) pushConfig();
    } catch {
      // Worker asleep or extension reloading; the hook keeps its safe defaults.
    }
  }

  document.addEventListener('popshield:blocked', (event) => {
    const detail = event.detail || {};
    chrome.runtime.sendMessage({ type: 'PS_BLOCKED', reason: detail.reason, targetUrl: detail.targetUrl }).catch(() => {});
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = changes.settings.newValue;
      pushConfig();
    }
  });

  // An interstitial is a fixed/sticky element that covers most of the viewport
  // and sits above the content. Size and position identify it; no text matching,
  // which would only ever work in one language.
  function findOverlays() {
    const viewport = window.innerWidth * window.innerHeight;
    if (!viewport) return [];
    const found = [];
    for (const node of document.body ? document.body.querySelectorAll('*') : []) {
      if (!(node instanceof HTMLElement) || node.hasAttribute(OVERLAY_MARK)) continue;
      const style = getComputedStyle(node);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (Number(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width * rect.height < viewport * 0.55) continue;
      const zIndex = Number.parseInt(style.zIndex, 10);
      if (!Number.isFinite(zIndex) || zIndex < 100) continue;
      found.push(node);
    }
    return found;
  }

  function releaseScrollLock() {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      const style = getComputedStyle(node);
      if (style.overflow === 'hidden' || style.position === 'fixed') {
        node.classList.add('popshield-scroll-unlock');
      }
    }
  }

  function killOverlays() {
    const overlays = findOverlays();
    for (const node of overlays) {
      node.setAttribute(OVERLAY_MARK, '1');
      node.style.setProperty('display', 'none', 'important');
    }
    releaseScrollLock();
    return overlays.length;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PS_KILL_OVERLAY') {
      sendResponse({ ok: true, removed: killOverlays() });
      return;
    }
    if (message?.type === 'PS_SCAN') {
      sendResponse({ ok: true, overlays: findOverlays().length });
    }
  });

  loadSettings();
})();
