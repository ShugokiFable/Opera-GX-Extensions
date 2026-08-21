'use strict';

const DEFAULTS = Object.freeze({
  enabled: true,
  requireGesture: true,
  gestureWindowMs: 1000,
  opensPerGesture: 1,
  maxOpensPerMinute: 3,
  blockAboutBlank: true,
  networkRules: true,
  allowlist: []
});

const STAT_DEFAULTS = Object.freeze({ blocked: 0, overlays: 0, lastBlockAt: 0, byReason: {} });
const MENU_KILL = 'ps-kill-overlay';
const MENU_ALLOW = 'ps-allow-site';
const RULESET = 'popup_networks';

let statsQueue = Promise.resolve();

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

function sanitize(input) {
  const next = { ...DEFAULTS, ...(input || {}) };
  next.enabled = Boolean(next.enabled);
  next.requireGesture = Boolean(next.requireGesture);
  next.blockAboutBlank = Boolean(next.blockAboutBlank);
  next.networkRules = Boolean(next.networkRules);
  next.gestureWindowMs = clamp(next.gestureWindowMs, 200, 5000, DEFAULTS.gestureWindowMs);
  next.opensPerGesture = clamp(next.opensPerGesture, 1, 5, DEFAULTS.opensPerGesture);
  next.maxOpensPerMinute = clamp(next.maxOpensPerMinute, 1, 30, DEFAULTS.maxOpensPerMinute);
  next.allowlist = Array.isArray(next.allowlist)
    ? [...new Set(next.allowlist.map((x) => String(x).trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean))]
    : [];
  return next;
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return sanitize(stored.settings);
}

async function setSettings(patch) {
  const next = sanitize({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ settings: next });
  await applyRulesets(next);
  return next;
}

// The blocklist is the backup layer, so it must be switchable independently of
// the behavioural engine.
async function applyRulesets(settings) {
  try {
    if (settings.networkRules) await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [RULESET] });
    else await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [RULESET] });
  } catch {
    // Ruleset already in the requested state.
  }
  // Per-site allows must reach the network layer too, or "allow popups on
  // this site" only un-blocks the behavioural engine and the blocklist keeps
  // killing the site's popunder scripts. One allow rule for the whole
  // allowlist; static block rules are priority 1, so 2 billion wins.
  // ponytail: single rule, initiatorDomains caps at 500 entries — plenty for a
  // popup allowlist; batch into multiple rules if someone ever exceeds that.
  const allowRule = {
    id: 1,
    priority: 2_147_483_647,
    action: { type: 'allow' },
    condition: {
      initiatorDomains: settings.allowlist,
      resourceTypes: ['image', 'other', 'ping', 'script', 'sub_frame', 'xmlhttprequest']
    }
  };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [allowRule.id],
      addRules: settings.allowlist.length ? [allowRule] : []
    });
  } catch (error) {
    console.error('PopShield: allowlist rule sync failed', error);
  }
}

function updateStats(patch) {
  const run = statsQueue.then(async () => {
    const stored = await chrome.storage.local.get('stats');
    const stats = { ...STAT_DEFAULTS, ...(stored.stats || {}) };
    stats.byReason = { ...(stats.byReason || {}) };
    for (const [key, value] of Object.entries(patch)) {
      stats[key] = typeof value === 'function' ? value(stats[key]) : value;
    }
    await chrome.storage.local.set({ stats });
    return stats;
  });
  statsQueue = run.catch(() => {});
  return run;
}

async function getStats() {
  const stored = await chrome.storage.local.get('stats');
  return { ...STAT_DEFAULTS, ...(stored.stats || {}) };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

async function setBadge(tabId, count) {
  if (!Number.isInteger(tabId)) return;
  await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff3158' }).catch(() => {});
}

const perTab = new Map();

async function ensureInstalled() {
  const stored = await chrome.storage.local.get(['settings', 'stats']);
  const writes = {};
  if (!stored.settings) writes.settings = { ...DEFAULTS };
  if (!stored.stats) writes.stats = { ...STAT_DEFAULTS };
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  await applyRulesets(await getSettings());

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_KILL, title: 'PopShield: remove blocking overlay', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_ALLOW, title: 'PopShield: allow popups on this site', contexts: ['page'] });
}

async function killOverlay(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'No tab.' };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PS_KILL_OVERLAY' });
    if (response?.removed) await updateStats({ overlays: (v) => (Number(v) || 0) + response.removed });
    return { ok: true, removed: response?.removed || 0 };
  } catch {
    return { ok: false, error: 'This page cannot be modified.' };
  }
}

async function setSiteAllowed(url, allowed) {
  const host = hostOf(url);
  if (!host) return { ok: false, error: 'No web hostname on this tab.' };
  const settings = await getSettings();
  const allowlist = allowed
    ? [...settings.allowlist, host]
    : settings.allowlist.filter((entry) => entry !== host && !host.endsWith(`.${entry}`));
  return { ok: true, host, allowed, settings: await setSettings({ allowlist }) };
}

chrome.runtime.onInstalled.addListener(() => { ensureInstalled().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { ensureInstalled().catch(console.error); });

chrome.tabs.onRemoved.addListener((tabId) => perTab.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') { perTab.set(tabId, 0); setBadge(tabId, 0); }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_KILL) await killOverlay(tab?.id);
  if (info.menuItemId === MENU_ALLOW) await setSiteAllowed(tab?.url, true);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'kill-overlay') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await killOverlay(tab?.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const execute = async () => {
    switch (message?.type) {
      case 'PS_GET_SETTINGS':
        return { settings: await getSettings() };
      case 'PS_SAVE_SETTINGS':
        return { settings: await setSettings(message.patch || {}) };
      case 'PS_BLOCKED': {
        const tabId = sender.tab?.id;
        const count = (perTab.get(tabId) || 0) + 1;
        perTab.set(tabId, count);
        await setBadge(tabId, count);
        const reason = String(message.reason || 'unknown');
        await updateStats({
          blocked: (v) => (Number(v) || 0) + 1,
          lastBlockAt: Date.now(),
          byReason: (v) => ({ ...(v || {}), [reason]: (Number(v?.[reason]) || 0) + 1 })
        });
        return { ok: true };
      }
      case 'PS_GET_STATE': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const settings = await getSettings();
        const host = hostOf(tab?.url);
        return {
          settings,
          stats: await getStats(),
          site: { host, allowed: Boolean(host) && settings.allowlist.some((e) => host === e || host.endsWith(`.${e}`)) },
          tabBlocked: perTab.get(tab?.id) || 0
        };
      }
      case 'PS_KILL_OVERLAY': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return killOverlay(tab?.id);
      }
      case 'PS_SET_SITE': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return setSiteAllowed(tab?.url, Boolean(message.allowed));
      }
      case 'PS_RESET_STATS':
        await chrome.storage.local.set({ stats: { ...STAT_DEFAULTS } });
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown message.' };
    }
  };
  execute().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

ensureInstalled().catch(console.error);
