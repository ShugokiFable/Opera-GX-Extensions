'use strict';

const DEFAULTS = {
  enabled: true,
  convertLightPages: true,
  strength: 88,
  blackCutoff: 18,
  targetContrast: 7,
  pureBlack: true,
  preserveBrandColors: true,
  mediaMode: 'untouched',
  sharpenText: false,
  panelGuard: false,
  idleDimMinutes: 0,
  idleShade: 14,
  staticUiOpacity: 78,
  performance: 'balanced',
  excludedSites: []
};

async function ensureDefaults() {
  const data = await chrome.storage.sync.get(['oledForgeSettings', 'oledForgeSites']);
  if (!data.oledForgeSettings) await chrome.storage.sync.set({ oledForgeSettings: DEFAULTS });
  if (!data.oledForgeSites) await chrome.storage.sync.set({ oledForgeSites: {} });
}

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function setBadge(tabId, active) {
  await chrome.action.setBadgeText({ tabId, text: active ? 'OLED' : '' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7257ff' }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'oled-forge-toggle-site',
      title: 'Toggle OLED Forge for this site',
      contexts: ['page', 'action']
    });
    chrome.contextMenus.create({
      id: 'oled-forge-rescan',
      title: 'Rescan page surfaces',
      contexts: ['page', 'action']
    });
  });
});

chrome.runtime.onStartup.addListener(ensureDefaults);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-oled-forge') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'OLED_FORGE_TOGGLE' });
    await setBadge(tab.id, Boolean(response?.active));
  } catch {
    await setBadge(tab.id, false);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'oled-forge-rescan') {
    chrome.tabs.sendMessage(tab.id, { type: 'OLED_FORGE_RESCAN' }).catch(() => {});
    return;
  }
  if (info.menuItemId !== 'oled-forge-toggle-site') return;

  const host = hostFromUrl(tab.url || '');
  if (!host) return;
  const data = await chrome.storage.sync.get('oledForgeSites');
  const sites = data.oledForgeSites || {};
  const current = sites[host] || { enabled: true };
  sites[host] = { ...current, enabled: !current.enabled };
  await chrome.storage.sync.set({ oledForgeSites: sites });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'OLED_FORGE_BADGE' && sender.tab?.id) {
    setBadge(sender.tab.id, Boolean(message.active));
  }
});
