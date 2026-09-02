importScripts('core.js', 'browser-resolver.js');
const C = globalThis.NexusArchiveCore;
const R = globalThis.NexusArchiveResolver;
const APP_HEADERS = { Accept: 'application/json', 'Application-Name': 'Nexus Archive Helper Personal', 'Application-Version': '1.1.1' };
let lastQuota = { hourlyRemaining: null, dailyRemaining: null, hourlyLimit: null, dailyLimit: null };

async function getApiKey() {
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  return String(apiKey).trim();
}
function quotaNumber(headers, name) {
  const value = headers.get(name);
  return value == null || value === '' ? null : Number(value);
}
async function apiRequest(url) {
  const key = await getApiKey();
  if (!key) throw { status: 0, data: { message: 'Add your Nexus Personal API key in Settings first.' } };
  const response = await fetch(url, { method: 'GET', headers: { ...APP_HEADERS, apikey: key } });
  lastQuota = {
    hourlyRemaining: quotaNumber(response.headers, 'x-rl-hourly-remaining'),
    dailyRemaining: quotaNumber(response.headers, 'x-rl-daily-remaining'),
    hourlyLimit: quotaNumber(response.headers, 'x-rl-hourly-limit'),
    dailyLimit: quotaNumber(response.headers, 'x-rl-daily-limit'),
  };
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }
  if (!response.ok) throw { status: response.status, data, message: response.statusText };
  return data;
}
async function recordHistory(result) {
  const { history = [] } = await chrome.storage.local.get('history');
  const archived = result.files.filter((f) => C.displayStatus(f, result.warnings) === 'ARCHIVED').length;
  const entry = { reference: C.referenceLabel(result.ref), at: Date.now(), total: result.files.length, archived, exactFileId: result.exact?.fileId || null };
  await chrome.storage.local.set({ history: C.mergeHistory(history, entry, 12) });
}
async function updateBadge(result) {
  const archived = result.files.filter((f) => C.displayStatus(f, result.warnings) === 'ARCHIVED').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#f28a1b' });
  await chrome.action.setBadgeText({ text: archived ? String(Math.min(archived, 99)) : '' });
}
async function resolveAndRecord(reference) {
  const ref = C.parseReference(reference);
  const result = await R.resolveFiles(ref, apiRequest);
  await recordHistory(result);
  await updateBadge(result);
  return result;
}
async function openHelper(reference, view) {
  await chrome.storage.local.set({ pendingReference: reference || '', pendingView: view || 'resolve' });
  await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?standalone=1') });
  return { ok: true, standaloneTab: true };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: 'nexus-archive-helper-resolve',
    title: 'Resolve with Nexus Archive Helper',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['https://www.nexusmods.com/*'],
    targetUrlPatterns: ['https://www.nexusmods.com/*'],
  }));
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'nexus-archive-helper-resolve') return;
  openHelper(info.linkUrl || info.pageUrl || '').catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'SAVE_KEY':
        await chrome.storage.local.set({ apiKey: String(message.apiKey || '').trim() });
        return { ok: true, quota: lastQuota };
      case 'GET_KEY':
        return { ok: true, apiKey: await getApiKey(), quota: lastQuota };
      case 'VALIDATE':
        return { ok: true, user: await R.validateUser(apiRequest), quota: lastQuota };
      case 'GET_QUOTA':
        return { ok: true, quota: lastQuota };
      case 'GET_HISTORY': {
        const { history = [] } = await chrome.storage.local.get('history');
        return { ok: true, history };
      }
      case 'CLEAR_HISTORY':
        await chrome.storage.local.set({ history: [] });
        return { ok: true };
      case 'RESOLVE':
      case 'SCAN_PAGE':
        return { ok: true, result: await resolveAndRecord(message.reference), quota: lastQuota };
      case 'DOWNLOAD': {
        const ref = C.parseReference(message.reference);
        return { ok: true, result: await R.resolveDownload(ref, Number(message.fileId), apiRequest), quota: lastQuota };
      }
      case 'OPEN_POPUP':
        return openHelper(message.reference, message.view);
      default:
        throw new Error('Unknown message type.');
    }
  })().then(sendResponse).catch((err) => sendResponse({ ok: false, error: C.errorMessage(err), quota: lastQuota }));
  return true;
});
