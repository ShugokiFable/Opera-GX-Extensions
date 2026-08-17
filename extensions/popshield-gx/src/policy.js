'use strict';

// Pure decision logic, deliberately free of DOM and chrome.* so the same code
// runs in the page's MAIN world and under node in tests/policy.test.cjs.
//
// The core idea: a blocklist of ad networks is always out of date, so it is the
// backup, not the defence. What actually separates a popunder from a legitimate
// window.open is behaviour - popunders fire without a real click, or fire
// several times off one click, or open a host unrelated to the page you are on.
(function attachPolicy(scope) {
  const DEFAULTS = Object.freeze({
    enabled: true,
    requireGesture: true,
    // A genuine "open in new window" happens within a few hundred ms of the
    // click that caused it. Popunders commonly fire on a timer afterwards.
    gestureWindowMs: 1000,
    // One window per gesture is what an honest page needs.
    opensPerGesture: 1,
    maxOpensPerMinute: 3,
    blockAboutBlank: true,
    allowlist: []
  });

  function normalizeHost(value) {
    if (typeof value !== 'string') return '';
    try {
      return new URL(value, 'https://invalid.example').hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function isAllowlisted(host, allowlist) {
    if (!host || !Array.isArray(allowlist)) return false;
    return allowlist.some((raw) => {
      const entry = String(raw || '').trim().toLowerCase().replace(/^\*\./, '');
      return entry && (host === entry || host.endsWith(`.${entry}`));
    });
  }

  function createState() {
    return { lastGestureAt: 0, opensThisGesture: 0, recentOpens: [], blocked: 0, allowed: 0 };
  }

  function noteGesture(state, now) {
    state.lastGestureAt = now;
    state.opensThisGesture = 0;
  }

  /**
   * Decide what to do with a window.open call.
   * Returns { allow: boolean, reason: string }.
   */
  function evaluateOpen(state, config, context) {
    const settings = { ...DEFAULTS, ...(config || {}) };
    const now = Number(context?.now) || 0;
    const pageHost = normalizeHost(context?.pageUrl);
    const targetHost = normalizeHost(context?.targetUrl);

    if (!settings.enabled) return { allow: true, reason: 'disabled' };
    if (isAllowlisted(pageHost, settings.allowlist)) return { allow: true, reason: 'site-allowlisted' };

    // about:blank and empty targets are the classic popunder shell: open a blank
    // window, then navigate it from script so no URL is ever visible to a filter.
    const rawTarget = String(context?.targetUrl || '').trim();
    if (settings.blockAboutBlank && (rawTarget === '' || /^about:blank$/i.test(rawTarget))) {
      return { allow: false, reason: 'blank-shell' };
    }

    const withinGesture = now - state.lastGestureAt <= settings.gestureWindowMs;
    if (settings.requireGesture && !withinGesture) {
      return { allow: false, reason: 'no-user-gesture' };
    }

    if (withinGesture && state.opensThisGesture >= settings.opensPerGesture) {
      return { allow: false, reason: 'extra-window-from-one-click' };
    }

    const cutoff = now - 60_000;
    const recent = state.recentOpens.filter((at) => at > cutoff);
    if (recent.length >= settings.maxOpensPerMinute) {
      return { allow: false, reason: 'rate-limit' };
    }

    if (targetHost && pageHost && targetHost !== pageHost && !withinGesture) {
      return { allow: false, reason: 'cross-site-without-gesture' };
    }

    return { allow: true, reason: 'ok' };
  }

  function recordOpen(state, now) {
    state.opensThisGesture += 1;
    state.recentOpens.push(now);
    if (state.recentOpens.length > 50) state.recentOpens.splice(0, state.recentOpens.length - 50);
    state.allowed += 1;
  }

  scope.PopShieldPolicy = { DEFAULTS, normalizeHost, isAllowlisted, createState, noteGesture, evaluateOpen, recordOpen };
})(typeof globalThis !== 'undefined' ? globalThis : self);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.PopShieldPolicy;
