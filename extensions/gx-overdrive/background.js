'use strict';

const DEFAULTS = Object.freeze({
  enabled: true,
  memoryGovernor: true,
  memoryPressurePercent: 12,
  emergencyDiscardBatch: 4,
  autoHibernate: true,
  inactiveMinutes: 35,
  maxHibernatePerCycle: 8,
  pressureMinIdleMinutes: 5,
  pressureCooldownMinutes: 10,
  protectPinned: true,
  protectAudible: true,
  protectDirtyForms: true,
  whitelist: [
    'localhost',
    '127.0.0.1'
  ],
  chatOptimizer: true,
  chatMaxVisibleTurns: 70,
  chatRevealBatch: 20,
  chatReduceEffects: true,
  universalTurbo: true,
  lazyImages: true,
  pauseOffscreenMutedVideo: true,
  reduceAnimations: false,
  reduceBlur: false,
  aggressiveContainment: false,
  downloadRecovery: true,
  autoResumeInterrupted: true,
  stallSeconds: 120,
  keepAwakeDuringDownloads: true
});

const STAT_DEFAULTS = Object.freeze({
  tabsDiscarded: 0,
  pressureEvents: 0,
  downloadsRecovered: 0,
  siteRepairs: 0,
  boostsApplied: 0,
  lastPressureAt: 0,
  lastRecoveryAt: 0
});

const ALARM_GOVERNOR = 'gx-overdrive-governor';
const ALARM_DOWNLOADS = 'gx-overdrive-downloads';
const MENU_BOOST = 'gx-boost-page';
const MENU_HIBERNATE = 'gx-hibernate-others';
const MENU_REPAIR = 'gx-repair-site';
const MENU_PROTECT = 'gx-protect-site';
const MENU_DASHBOARD = 'gx-open-dashboard';

const HIBERNATION_LOG_LIMIT = 25;

let awakeRequested = false;
let downloadRecoveryPromise = null;
// Serialises read-modify-write on the shared stats object; the governor and the
// download watcher both tick on the same minute alarm and used to lose counts.
let statsQueue = Promise.resolve();

function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function isWhitelisted(url, whitelist) {
  const host = safeHostname(url);
  if (!host) return true;
  return whitelist.some((entry) => {
    const normalized = String(entry || '').trim().toLowerCase().replace(/^\*\./, '');
    return normalized && (host === normalized || host.endsWith(`.${normalized}`));
  });
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  next.memoryPressurePercent = Math.min(40, Math.max(3, Number(next.memoryPressurePercent) || 12));
  next.inactiveMinutes = Math.min(1440, Math.max(5, Number(next.inactiveMinutes) || 35));
  next.chatMaxVisibleTurns = Math.min(500, Math.max(10, Number(next.chatMaxVisibleTurns) || 70));
  next.chatRevealBatch = Math.min(100, Math.max(5, Number(next.chatRevealBatch) || 20));
  next.stallSeconds = Math.min(900, Math.max(60, Number(next.stallSeconds) || 120));
  next.maxHibernatePerCycle = Math.min(50, Math.max(1, Number(next.maxHibernatePerCycle) || 8));
  next.emergencyDiscardBatch = Math.min(25, Math.max(1, Number(next.emergencyDiscardBatch) || 4));
  next.pressureMinIdleMinutes = Math.min(120, Math.max(0, Number(next.pressureMinIdleMinutes) ?? 5));
  next.pressureCooldownMinutes = Math.min(120, Math.max(1, Number(next.pressureCooldownMinutes) || 10));
  next.whitelist = Array.isArray(next.whitelist)
    ? [...new Set(next.whitelist.map((x) => String(x).trim().toLowerCase()).filter(Boolean))]
    : [];
  await chrome.storage.local.set({ settings: next });
  return next;
}

function updateStats(patch) {
  const run = statsQueue.then(async () => {
    const stored = await chrome.storage.local.get('stats');
    const stats = { ...STAT_DEFAULTS, ...(stored.stats || {}) };
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

async function buildInitialSettings() {
  const memory = await queryMemory();
  const gib = memory.capacity / (1024 ** 3);
  if (gib >= 48) {
    return { ...DEFAULTS, memoryPressurePercent: 8, inactiveMinutes: 50, chatMaxVisibleTurns: 90 };
  }
  if (gib >= 24) {
    return { ...DEFAULTS, memoryPressurePercent: 10, inactiveMinutes: 40, chatMaxVisibleTurns: 75 };
  }
  if (gib >= 12) {
    return { ...DEFAULTS, memoryPressurePercent: 14, inactiveMinutes: 30, chatMaxVisibleTurns: 60 };
  }
  return { ...DEFAULTS, memoryPressurePercent: 18, inactiveMinutes: 20, chatMaxVisibleTurns: 45 };
}

async function ensureInitialized() {
  const stored = await chrome.storage.local.get(['settings', 'stats']);
  const writes = {};
  if (!stored.settings) writes.settings = await buildInitialSettings();
  if (!stored.stats) writes.stats = { ...STAT_DEFAULTS };
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);

  await chrome.alarms.create(ALARM_GOVERNOR, { periodInMinutes: 1 });
  await chrome.alarms.create(ALARM_DOWNLOADS, { periodInMinutes: 1 });
  await rebuildContextMenus();
}

async function rebuildContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_BOOST, title: 'GX Overdrive: boost this page', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_HIBERNATE, title: 'GX Overdrive: hibernate other tabs', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_PROTECT, title: 'GX Overdrive: never hibernate this site', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_REPAIR, title: 'GX Overdrive: repair this site cache', contexts: ['page'] });
  chrome.contextMenus.create({ id: MENU_DASHBOARD, title: 'GX Overdrive dashboard', contexts: ['action'] });
}

async function queryMemory() {
  try {
    const info = await chrome.system.memory.getInfo();
    const freePercent = info.capacity > 0 ? (info.availableCapacity / info.capacity) * 100 : 100;
    return {
      capacity: info.capacity,
      available: info.availableCapacity,
      freePercent
    };
  } catch {
    return { capacity: 0, available: 0, freePercent: 100 };
  }
}

async function askTab(tabId, message, timeoutMs = 750) {
  // A frozen or busy page can leave sendMessage pending forever, which used to
  // stall the whole governor pass. No answer inside the budget means "unknown".
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

async function canDiscardTab(tab, settings) {
  if (!tab?.id || tab.active || tab.discarded || !isWebUrl(tab.url)) return false;
  if (tab.autoDiscardable === false) return false;
  if (tab.status === 'loading') return false;
  if (settings.protectPinned && tab.pinned) return false;
  if (settings.protectAudible && tab.audible) return false;
  if (isWhitelisted(tab.url, settings.whitelist)) return false;

  if (settings.protectDirtyForms) {
    const response = await askTab(tab.id, { type: 'GX_CAN_DISCARD' });
    // Pages without an injected content script are judged by tab metadata only.
    if (response && response.canDiscard === false) return false;
  }
  return true;
}

async function recordHibernations(tabs) {
  if (!tabs.length) return;
  const stored = await chrome.storage.local.get('hibernationLog');
  const log = Array.isArray(stored.hibernationLog) ? stored.hibernationLog : [];
  const entries = tabs.map((tab) => ({
    id: tab.id,
    title: tab.title || safeHostname(tab.url) || 'Tab',
    url: tab.url,
    host: safeHostname(tab.url),
    at: Date.now()
  }));
  await chrome.storage.local.set({ hibernationLog: [...entries, ...log].slice(0, HIBERNATION_LOG_LIMIT) });
}

async function discardCandidates(candidates, settings, limit) {
  const hibernated = [];
  for (const tab of candidates) {
    if (hibernated.length >= limit) break;
    if (!(await canDiscardTab(tab, settings))) continue;
    try {
      await chrome.tabs.discard(tab.id);
      tab.discarded = true;
      hibernated.push(tab);
    } catch {
      // The browser may reject protected/internal tabs or a tab that changed state.
    }
  }
  if (hibernated.length) {
    await updateStats({ tabsDiscarded: (v) => (Number(v) || 0) + hibernated.length });
    await recordHibernations(hibernated);
  }
  return hibernated.length;
}

async function getGovernorState() {
  const store = chrome.storage.session || chrome.storage.local;
  const stored = await store.get('governor');
  return stored.governor || {};
}

async function setGovernorState(patch) {
  const store = chrome.storage.session || chrome.storage.local;
  const current = await getGovernorState();
  await store.set({ governor: { ...current, ...patch } });
}

function coldestFirst(tabs) {
  return tabs
    .filter((tab) => !tab.active)
    .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
}

async function runGovernor({ forceOthers = false } = {}) {
  const settings = await getSettings();

  // An explicit click or hotkey is a user decision: it still honours the guard
  // rails (pinned/audible/whitelist/unsaved forms) but not the automatic gates.
  if (forceOthers) {
    const candidates = coldestFirst(await chrome.tabs.query({}));
    return { discarded: await discardCandidates(candidates, settings, settings.maxHibernatePerCycle) };
  }

  const idleHibernation = settings.enabled && settings.autoHibernate;
  const pressureHibernation = settings.enabled && settings.memoryGovernor;
  if (!idleHibernation && !pressureHibernation) {
    await clearBadge();
    return { discarded: 0 };
  }

  const now = Date.now();
  const candidates = coldestFirst(await chrome.tabs.query({}));
  let discarded = 0;

  if (idleHibernation) {
    const cutoff = now - settings.inactiveMinutes * 60_000;
    const stale = candidates.filter((tab) => (tab.lastAccessed || now) < cutoff);
    discarded += await discardCandidates(stale, settings, settings.maxHibernatePerCycle);
  }

  if (!pressureHibernation) return { discarded };

  const memory = await queryMemory();
  await setBadge(memory.freePercent);
  if (memory.freePercent >= settings.memoryPressurePercent) return { discarded, memory };

  // Pressure on Windows is often sustained for many minutes. Without a cooldown
  // and an idle floor this branch ate a fresh batch of tabs every single minute,
  // including the tab the user had just switched away from.
  const governor = await getGovernorState();
  if (now - (governor.lastPressureDiscardAt || 0) < settings.pressureCooldownMinutes * 60_000) {
    return { discarded, memory };
  }
  const floor = now - settings.pressureMinIdleMinutes * 60_000;
  const pool = candidates.filter((tab) => !tab.discarded && (tab.lastAccessed || now) < floor);
  const emergency = await discardCandidates(pool, settings, settings.emergencyDiscardBatch);
  discarded += emergency;
  await updateStats({ pressureEvents: (v) => (Number(v) || 0) + 1, lastPressureAt: now });
  if (emergency) await setGovernorState({ lastPressureDiscardAt: now });
  return { discarded, memory };
}

async function setBadge(freePercent) {
  const value = Math.round(freePercent);
  const text = value < 20 ? `${value}` : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: value < 10 ? '#ff3158' : '#8d4dff' });
  await chrome.action.setTitle({ title: `GX Overdrive • ${value}% physical memory free` });
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'GX Overdrive • tab hibernation off' });
}

async function getDownloadWatch() {
  const stored = await chrome.storage.local.get('downloadWatch');
  return stored.downloadWatch || {};
}

async function setDownloadWatch(value) {
  await chrome.storage.local.set({ downloadWatch: value });
}

async function setKeepAwake(needed) {
  if (needed && !awakeRequested) {
    chrome.power.requestKeepAwake('system');
    awakeRequested = true;
  } else if (!needed && awakeRequested) {
    chrome.power.releaseKeepAwake();
    awakeRequested = false;
  }
}

async function runDownloadRecoveryImpl() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.downloadRecovery) {
    await setKeepAwake(false);
    return { active: 0, recovered: 0 };
  }

  const now = Date.now();
  const [active, interrupted] = await Promise.all([
    chrome.downloads.search({ state: 'in_progress' }),
    settings.autoResumeInterrupted ? chrome.downloads.search({ state: 'interrupted' }) : Promise.resolve([])
  ]);

  await setKeepAwake(settings.keepAwakeDuringDownloads && active.length > 0);

  const watch = await getDownloadWatch();
  const nextWatch = {};
  let recovered = 0;

  for (const item of active) {
    const previous = watch[item.id] || {
      bytesReceived: item.bytesReceived || 0,
      lastProgressAt: now,
      lastRecoveryAt: 0
    };
    const progressed = (item.bytesReceived || 0) > (previous.bytesReceived || 0);
    const record = {
      bytesReceived: item.bytesReceived || 0,
      lastProgressAt: progressed ? now : previous.lastProgressAt || now,
      lastRecoveryAt: previous.lastRecoveryAt || 0
    };

    const stalledFor = now - record.lastProgressAt;
    const recoveryCooldown = now - record.lastRecoveryAt;
    if (item.canResume && stalledFor >= settings.stallSeconds * 1000 && recoveryCooldown >= 5 * 60_000) {
      try {
        await chrome.downloads.pause(item.id);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await chrome.downloads.resume(item.id);
        record.lastRecoveryAt = now;
        record.lastProgressAt = now;
        recovered += 1;
      } catch {
        // Some servers or browser-managed downloads cannot be cycled.
      }
    }
    nextWatch[item.id] = record;
  }

  for (const item of interrupted) {
    if (!item.canResume) continue;
    const startedAt = Date.parse(item.startTime || '') || 0;
    if (!startedAt || now - startedAt > 6 * 60 * 60_000) continue;
    const previous = watch[item.id] || {};
    if (now - (previous.lastRecoveryAt || 0) < 5 * 60_000) {
      nextWatch[item.id] = previous;
      continue;
    }
    nextWatch[item.id] = {
      bytesReceived: item.bytesReceived || 0,
      lastProgressAt: previous.lastProgressAt || now,
      lastRecoveryAt: now
    };
    try {
      await chrome.downloads.resume(item.id);
      recovered += 1;
    } catch {
      // Resume is best-effort and depends on server range support.
    }
  }

  await setDownloadWatch(nextWatch);
  if (recovered) {
    await updateStats({
      downloadsRecovered: (v) => (Number(v) || 0) + recovered,
      lastRecoveryAt: now
    });
  }
  return { active: active.length, recovered };
}

function runDownloadRecovery() {
  if (downloadRecoveryPromise) return downloadRecoveryPromise;
  downloadRecoveryPromise = runDownloadRecoveryImpl().finally(() => {
    downloadRecoveryPromise = null;
  });
  return downloadRecoveryPromise;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function boostTab(tabId) {
  if (!tabId) return { ok: false, error: 'No active tab.' };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GX_APPLY_NOW' });
    await updateStats({ boostsApplied: (v) => (Number(v) || 0) + 1 });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: error?.message || 'This page cannot be optimized.' };
  }
}

async function setSiteProtection(tab, wanted) {
  const host = safeHostname(tab?.url);
  if (!host || !isWebUrl(tab?.url)) return { ok: false, error: 'No web hostname on this tab.' };
  const settings = await getSettings();
  const isProtected = isWhitelisted(tab.url, settings.whitelist);
  const shouldProtect = typeof wanted === 'boolean' ? wanted : !isProtected;
  if (shouldProtect === isProtected) return { ok: true, host, protected: isProtected, settings };
  const whitelist = shouldProtect
    ? [...settings.whitelist, host]
    : settings.whitelist.filter((entry) => {
        const normalized = String(entry || '').trim().toLowerCase().replace(/^\*\./, '');
        return normalized !== host && !host.endsWith(`.${normalized}`);
      });
  return { ok: true, host, protected: shouldProtect, settings: await setSettings({ whitelist }) };
}

async function repairCurrentSite() {
  const tab = await getActiveTab();
  if (!tab || !isWebUrl(tab.url)) return { ok: false, error: 'This page has no repairable web origin.' };
  const origin = new URL(tab.url).origin;
  await chrome.browsingData.removeCache({ origins: [origin] });
  await chrome.browsingData.removeCacheStorage({ origins: [origin] });
  await updateStats({ siteRepairs: (v) => (Number(v) || 0) + 1 });
  return { ok: true, origin };
}

async function collectState() {
  const [settings, stats, memory, tabs, activeDownloads, activeTab, stored] = await Promise.all([
    getSettings(),
    getStats(),
    queryMemory(),
    chrome.tabs.query({}),
    chrome.downloads.search({ state: 'in_progress' }),
    getActiveTab(),
    chrome.storage.local.get('hibernationLog')
  ]);
  const activeHost = safeHostname(activeTab?.url);
  return {
    settings,
    stats,
    memory,
    site: {
      host: activeHost,
      protected: Boolean(activeHost) && isWhitelisted(activeTab?.url, settings.whitelist)
    },
    hibernationLog: Array.isArray(stored.hibernationLog) ? stored.hibernationLog : [],
    tabs: {
      total: tabs.length,
      discarded: tabs.filter((tab) => tab.discarded).length,
      audible: tabs.filter((tab) => tab.audible).length
    },
    downloads: {
      active: activeDownloads.length,
      items: activeDownloads.slice(0, 12)
    }
  };
}

chrome.runtime.onInstalled.addListener(() => {
  ensureInitialized().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  ensureInitialized().catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_GOVERNOR) runGovernor().catch(console.error);
  if (alarm.name === ALARM_DOWNLOADS) runDownloadRecovery().catch(console.error);
});

chrome.downloads.onCreated.addListener(() => {
  runDownloadRecovery().catch(console.error);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.error || delta.paused) runDownloadRecovery().catch(console.error);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_BOOST) await boostTab(tab?.id);
  if (info.menuItemId === MENU_HIBERNATE) await runGovernor({ forceOthers: true });
  if (info.menuItemId === MENU_PROTECT) await setSiteProtection(tab, true);
  if (info.menuItemId === MENU_REPAIR) await repairCurrentSite();
  if (info.menuItemId === MENU_DASHBOARD) await chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'boost-current-tab') {
    const tab = await getActiveTab();
    await boostTab(tab?.id);
  }
  if (command === 'hibernate-other-tabs') {
    await runGovernor({ forceOthers: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const execute = async () => {
    switch (message?.type) {
      case 'GX_GET_STATE':
        return collectState();
      case 'GX_GET_SETTINGS':
        return { settings: await getSettings() };
      case 'GX_SAVE_SETTINGS':
        return { settings: await setSettings(message.patch || {}) };
      case 'GX_BOOST_ACTIVE': {
        const tab = await getActiveTab();
        return boostTab(tab?.id);
      }
      case 'GX_HIBERNATE_OTHERS':
        return runGovernor({ forceOthers: true });
      case 'GX_REPAIR_SITE':
        return repairCurrentSite();
      case 'GX_OPEN_DASHBOARD':
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case 'GX_SET_SITE_PROTECTION': {
        const tab = await getActiveTab();
        return setSiteProtection(tab, message.protected);
      }
      case 'GX_RESTORE_TAB': {
        const id = Number(message.id);
        if (!Number.isInteger(id)) return { ok: false, error: 'Invalid tab ID.' };
        const tab = await chrome.tabs.update(id, { active: true }).catch(() => null);
        if (!tab) return { ok: false, error: 'That tab is gone.' };
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        return { ok: true };
      }
      case 'GX_CLEAR_HIBERNATION_LOG':
        await chrome.storage.local.set({ hibernationLog: [] });
        return { ok: true };
      case 'GX_DOWNLOAD_ACTION': {
        const id = Number(message.id);
        if (!Number.isInteger(id)) return { ok: false, error: 'Invalid download ID.' };
        if (message.action === 'pause') await chrome.downloads.pause(id);
        else if (message.action === 'resume') await chrome.downloads.resume(id);
        else if (message.action === 'show') await chrome.downloads.show(id);
        else return { ok: false, error: 'Unknown download action.' };
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown message.' };
    }
  };

  execute().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

ensureInitialized().catch(console.error);
