'use strict';

importScripts('common.js');

const MENU = Object.freeze({
  ROOT: 'nocturne-root',
  TOGGLE_SITE: 'nocturne-toggle-site',
  CYCLE_PRESET: 'nocturne-cycle-preset',
  OPEN_STUDIO: 'nocturne-open-studio'
});

async function initializeStorage() {
  const local = await chrome.storage.local.get([Nocturne.STORAGE_KEYS.GLOBAL, Nocturne.STORAGE_KEYS.RULES]);
  const writes = [];
  if (!local[Nocturne.STORAGE_KEYS.GLOBAL]) {
    // readState folds a pre-1.0.2 storage.sync profile forward, so this both
    // seeds defaults and completes the migration on first run after the update.
    const { global } = await Nocturne.readState();
    writes.push(Nocturne.writeGlobal(global));
  }
  if (!local[Nocturne.STORAGE_KEYS.RULES]) {
    writes.push(Nocturne.writeRules({}));
  }
  await Promise.all(writes);
}

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.ROOT,
      title: 'Nocturne Scrollbars GX',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: MENU.TOGGLE_SITE,
      parentId: MENU.ROOT,
      title: 'Toggle on this site',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: MENU.CYCLE_PRESET,
      parentId: MENU.ROOT,
      title: 'Cycle global preset',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: MENU.OPEN_STUDIO,
      parentId: MENU.ROOT,
      title: 'Open Nocturne Studio',
      contexts: ['page', 'frame']
    });
  });
}

async function updateGlobalBadge() {
  try {
    const { global } = await Nocturne.readState();
    await chrome.action.setBadgeText({ text: global.enabled ? '' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#cc2f55' });
    await chrome.action.setTitle({ title: global.enabled ? 'Nocturne Scrollbars GX' : 'Nocturne Scrollbars GX — globally disabled' });
  } catch (error) {
    console.warn('Nocturne badge update failed:', error);
  }
}

async function toggleSiteForUrl(url) {
  const host = Nocturne.domainFromUrl(url);
  if (!host) return false;
  const { global, rules } = await Nocturne.readState();
  const current = Nocturne.effectiveSettings(global, rules, host);
  await Nocturne.setSiteRule(host, { enabled: !current.siteEnabled });
  return !current.siteEnabled;
}

async function cyclePreset() {
  const { global } = await Nocturne.readState();
  const ids = Object.keys(Nocturne.PRESETS);
  const currentIndex = Math.max(0, ids.indexOf(global.preset));
  const next = ids[(currentIndex + 1) % ids.length];
  await Nocturne.writeGlobal(Nocturne.applyPreset(global, next));
  return next;
}

async function notifyTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'NOCTURNE_REFRESH' });
  } catch {
    // Restricted browser pages and not-yet-ready tabs cannot receive content-script messages.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initializeStorage().catch(console.error);
  buildContextMenus();
  updateGlobalBadge();
});

chrome.runtime.onStartup.addListener(() => {
  initializeStorage().catch(console.error);
  updateGlobalBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === MENU.TOGGLE_SITE) {
      await toggleSiteForUrl(info.frameUrl || info.pageUrl || tab?.url || '');
      await notifyTab(tab?.id);
    } else if (info.menuItemId === MENU.CYCLE_PRESET) {
      await cyclePreset();
      await notifyTab(tab?.id);
    } else if (info.menuItemId === MENU.OPEN_STUDIO) {
      await chrome.runtime.openOptionsPage();
    }
  } catch (error) {
    console.error('Nocturne menu action failed:', error);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (command === 'toggle-current-site') {
      await toggleSiteForUrl(tab?.url || '');
      await notifyTab(tab?.id);
    } else if (command === 'cycle-preset') {
      await cyclePreset();
      await notifyTab(tab?.id);
    }
  } catch (error) {
    console.error('Nocturne command failed:', error);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[Nocturne.STORAGE_KEYS.GLOBAL]) updateGlobalBadge();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'NOCTURNE_GET_EFFECTIVE') {
    (async () => {
      const host = Nocturne.domainFromUrl(message.url || sender.url || '');
      const { global, rules } = await Nocturne.readState();
      sendResponse({ ok: true, host, ...Nocturne.effectiveSettings(global, rules, host) });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

initializeStorage().catch(console.error);
updateGlobalBadge();
