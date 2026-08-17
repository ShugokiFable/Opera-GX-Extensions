'use strict';

// Runs in the page's MAIN world at document_start, before site scripts, so the
// wrapper is already installed when a popunder script caches window.open.
// It cannot use chrome.* APIs at all - config arrives from guard.js by event.
(() => {
  const policy = globalThis.PopShieldPolicy;
  if (!policy || window.__popShieldInstalled) return;
  window.__popShieldInstalled = true;

  let config = { ...policy.DEFAULTS };
  const state = policy.createState();

  document.addEventListener('popshield:config', (event) => {
    const next = event.detail;
    if (next && typeof next === 'object') config = { ...policy.DEFAULTS, ...next };
  });

  function report(reason, targetUrl) {
    document.dispatchEvent(new CustomEvent('popshield:blocked', { detail: { reason, targetUrl: String(targetUrl || '') } }));
  }

  // Trusted events only. A script-dispatched click has isTrusted false, which is
  // exactly how a popunder fakes the gesture it needs.
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
    window.addEventListener(type, (event) => {
      if (event.isTrusted) policy.noteGesture(state, Date.now());
    }, { capture: true, passive: true });
  }

  const nativeOpen = window.open;
  const wrappedOpen = function open(url, target, features) {
    const verdict = policy.evaluateOpen(state, config, {
      now: Date.now(),
      pageUrl: location.href,
      targetUrl: url
    });

    if (!verdict.allow) {
      state.blocked += 1;
      report(verdict.reason, url);
      // Returning a stub rather than null: popunder scripts frequently call
      // .blur()/.focus()/.location= on the result, and a null would throw, which
      // some pages catch and use as a signal to retry with another technique.
      return {
        closed: true,
        opener: null,
        focus() {}, blur() {}, close() {}, print() {}, postMessage() {},
        get location() { return { href: '', assign() {}, replace() {} }; },
        set location(_value) { /* swallowed */ },
        document: { write() {}, writeln() {}, close() {} }
      };
    }

    policy.recordOpen(state, Date.now());
    return nativeOpen.call(window, url, target, features);
  };

  try {
    Object.defineProperty(window, 'open', {
      configurable: false,
      writable: false,
      value: wrappedOpen
    });
  } catch {
    window.open = wrappedOpen; // Non-configurable already: best effort.
  }

  // The other half of the popunder trick: an anchor with target=_blank whose
  // click handler also navigates the current tab somewhere else.
  window.addEventListener('click', (event) => {
    if (!config.enabled || !event.isTrusted) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[target="_blank"]') : null;
    if (!anchor) return;
    // rel=noopener stops the new window controlling this one. Sites that leave
    // it off are the ones that can pull the tab under.
    const rel = (anchor.getAttribute('rel') || '').toLowerCase();
    if (!rel.includes('noopener')) anchor.setAttribute('rel', `${rel} noopener noreferrer`.trim());
  }, { capture: true });
})();
