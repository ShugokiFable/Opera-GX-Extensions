'use strict';

const state = {
  tab: null,
  items: [],
  stats: {},
  filter: 'all',
  query: '',
  sort: 'quality',
  selected: new Set(),
  settings: null
};

const $ = (selector) => document.querySelector(selector);
const els = {
  activeTitle: $('#activeTitle'), activeUrl: $('#activeUrl'), mediaTable: $('#mediaTable'), status: $('#status'),
  metricTotal: $('#metricTotal'), metricSelected: $('#metricSelected'), metricSize: $('#metricSize'), metricHelper: $('#metricHelper')
};

init().catch((error) => setStatus(error.message, 'error'));

async function init() {
  const params = new URLSearchParams(location.search);
  const requestedTabId = Number(params.get('tab'));
  const active = await send({ type: 'GET_ACTIVE_TAB' });
  if (Number.isFinite(requestedTabId) && requestedTabId > 0) {
    try { state.tab = (await send({ type: 'GET_TAB', tabId: requestedTabId })).tab; }
    catch (_) { state.tab = { id: requestedTabId, title: 'Captured tab', url: '' }; }
  } else {
    state.tab = active.tab;
  }
  if (!state.tab) throw new Error('No browser tab is available.');

  state.settings = (await send({ type: 'GET_SETTINGS' })).settings;
  applySettingsForm();
  await refresh();
  void testHelper(false);
  setInterval(() => refresh().catch(() => {}), 2500);
}

async function refresh() {
  const response = await send({ type: 'GET_ITEMS', tabId: state.tab.id });
  state.items = response.items || [];
  state.stats = response.stats || {};
  els.activeTitle.textContent = state.tab.title || 'Captured media';
  els.activeUrl.textContent = state.tab.url || `Tab ${state.tab.id}`;
  updateMetrics();
  render();
}

function visibleItems() {
  const query = state.query.toLowerCase();
  const list = state.items.filter((item) => {
    const filterMatch = state.filter === 'all' ||
      (state.filter === 'stream' && ['hls', 'dash', 'segment'].includes(item.kind)) ||
      item.kind === state.filter;
    const haystack = `${item.filename} ${item.url} ${item.kind} ${item.mime} ${item.source} ${item.width || ''}x${item.height || ''}`.toLowerCase();
    return filterMatch && (!query || haystack.includes(query));
  });

  return list.sort((a, b) => {
    if (state.sort === 'newest') return b.createdAt - a.createdAt;
    if (state.sort === 'size') return (b.size || b.blobSize || 0) - (a.size || a.blobSize || 0);
    if (state.sort === 'name') return (a.filename || '').localeCompare(b.filename || '');
    return qualityScore(b) - qualityScore(a);
  });
}

function render() {
  const list = visibleItems();
  if (!list.length) {
    els.mediaTable.innerHTML = '<div class="empty"><strong>No matching media</strong>Play the media, scroll lazy-loaded content into view, then run a rescan.</div>';
    return;
  }

  els.mediaTable.innerHTML = list.map((item) => {
    const selected = state.selected.has(item.id);
    const blocked = item.drm || item.encrypted;
    return `
      <article class="dashboard-row ${selected ? 'selected' : ''}" data-id="${escapeHtml(item.id)}">
        <div><input class="row-check" type="checkbox" ${selected ? 'checked' : ''} ${blocked ? 'disabled' : ''}></div>
        <div class="media-cell">
          <div class="thumb">${item.kind === 'image' ? `<img src="${escapeAttr(item.url)}" alt="">` : escapeHtml(shortKind(item.kind))}</div>
          <div class="media-main">
            <div class="media-name" title="${escapeAttr(item.filename)}">${escapeHtml(item.filename || 'media')}</div>
            <div class="media-url" title="${escapeAttr(item.url)}">${escapeHtml(item.url)}</div>
            <div class="media-meta">${blocked ? '<span class="badge badge-danger">encrypted / DRM</span>' : `<span>${escapeHtml(hostname(item.url))}</span>`}</div>
          </div>
        </div>
        <div><span class="badge badge-${escapeHtml(item.kind)}">${escapeHtml(item.kind)}</span></div>
        <div class="cell-text">${escapeHtml(formatQuality(item))}</div>
        <div class="cell-text">${escapeHtml(formatBytes(item.size || item.blobSize))}</div>
        <div class="cell-text" title="${escapeAttr(item.source)}">${escapeHtml(item.source || 'page')}</div>
        <div class="row-actions">
          ${['hls','dash'].includes(item.kind) ? '<button class="btn analyze-btn" title="Analyze manifest">⌁</button>' : ''}
          <button class="btn download-btn" title="${item.kind === 'segment' ? 'Assemble captured fragments' : 'Download'}" ${blocked ? 'disabled' : ''}>↓</button>
        </div>
      </article>`;
  }).join('');
}

function updateMetrics() {
  const selectedItems = state.items.filter((item) => state.selected.has(item.id));
  els.metricTotal.textContent = state.items.length;
  els.metricSelected.textContent = state.selected.size;
  els.metricSize.textContent = formatBytes(selectedItems.reduce((sum, item) => sum + (item.size || item.blobSize || 0), 0));
  $('#countAll').textContent = state.stats.total || 0;
  $('#countVideo').textContent = state.stats.video || 0;
  $('#countStream').textContent = (state.stats.hls || 0) + (state.stats.dash || 0) + (state.stats.segment || 0);
  $('#countImage').textContent = state.stats.image || 0;
  $('#countAudio').textContent = state.stats.audio || 0;
  $('#countBlob').textContent = state.stats.blob || 0;
  $('#downloadSelectedBtn').disabled = state.selected.size === 0;
}

$('#sideFilters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-kind]');
  if (!button) return;
  state.filter = button.dataset.kind;
  document.querySelectorAll('.side-link').forEach((link) => link.classList.toggle('active', link === button));
  render();
});

$('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; render(); });
$('#sortSelect').addEventListener('change', (event) => { state.sort = event.target.value; render(); });
$('#refreshBtn').addEventListener('click', () => refresh().catch((error) => setStatus(error.message, 'error')));

$('#selectVisible').addEventListener('change', (event) => {
  for (const item of visibleItems()) {
    if (item.drm || item.encrypted) continue;
    if (event.target.checked) state.selected.add(item.id); else state.selected.delete(item.id);
  }
  updateMetrics();
  render();
});

els.mediaTable.addEventListener('change', (event) => {
  const checkbox = event.target.closest('.row-check');
  if (!checkbox) return;
  const id = checkbox.closest('[data-id]').dataset.id;
  if (checkbox.checked) state.selected.add(id); else state.selected.delete(id);
  updateMetrics();
  render();
});

els.mediaTable.addEventListener('click', async (event) => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  const id = row.dataset.id;

  if (event.target.closest('.analyze-btn')) {
    setStatus('Analyzing manifest…');
    try {
      const response = await send({ type: 'ANALYZE_MANIFEST', tabId: state.tab.id, id });
      const a = response.analysis;
      setStatus(a.drm || a.encrypted ? 'Encryption or DRM detected. Download disabled.' : `Manifest clean. ${a.variants?.length || 0} variants found.`, a.drm || a.encrypted ? 'error' : 'success');
      await refresh();
    } catch (error) { setStatus(error.message, 'error'); }
  }

  if (event.target.closest('.download-btn')) await downloadOne(id);
});

$('#downloadSelectedBtn').addEventListener('click', async () => {
  const button = $('#downloadSelectedBtn');
  button.disabled = true;
  setStatus(`Starting ${state.selected.size} download(s)…`);
  try {
    const response = await send({ type: 'DOWNLOAD_ITEMS', tabId: state.tab.id, ids: [...state.selected] });
    const failures = (response.results || []).filter((r) => !r.ok);
    setStatus(failures.length ? `${response.results.length - failures.length} started, ${failures.length} failed. ${failures[0].error}` : `${response.results.length} download(s) started.`, failures.length ? 'error' : 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { updateMetrics(); }
});

$('#smartFetchBtn').addEventListener('click', async () => {
  const button = $('#smartFetchBtn');
  button.disabled = true;
  setStatus('Sending page to Smart Fetch…');
  try {
    const response = await send({ type: 'SMART_FETCH_PAGE', tabId: state.tab.id });
    setStatus(`Smart Fetch job ${response.jobId} started with resumable fragment caching.`, 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { button.disabled = false; }
});

$('#scanBtn').addEventListener('click', async () => {
  setStatus('Scanning all page frames…');
  try {
    await send({ type: 'SCAN_TAB', tabId: state.tab.id });
    setTimeout(() => refresh().catch(() => {}), 700);
    setStatus('Scan dispatched.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
});

$('#clearBtn').addEventListener('click', async () => {
  await send({ type: 'CLEAR_TAB', tabId: state.tab.id });
  state.selected.clear();
  await refresh();
  setStatus('Capture list cleared.', 'success');
});

async function downloadOne(id) {
  setStatus('Starting download…');
  try {
    const response = await send({ type: 'DOWNLOAD_ITEM', tabId: state.tab.id, id });
    setStatus(response.mode === 'helper' ? `Companion job ${response.jobId} started.` : 'Download started.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
}

$('#settingsBtn').addEventListener('click', () => { applySettingsForm(); $('#settingsDialog').showModal(); });
$('#saveSettingsBtn').addEventListener('click', async () => {
  const next = collectSettingsForm();
  const response = await send({ type: 'SAVE_SETTINGS', settings: next });
  state.settings = response.settings;
  $('#settingsDialog').close();
  setStatus('Settings saved.', 'success');
  void testHelper(false);
});
$('#testHelperBtn').addEventListener('click', () => testHelper(true));

function applySettingsForm() {
  if (!state.settings) return;
  for (const key of ['downloadFolder', 'maxItemsPerTab', 'helperUrl', 'helperToken', 'helperContainer', 'smartFetchBrowser']) $(`#${key}`).value = state.settings[key] ?? '';
  for (const key of ['reliableDownloads', 'fallbackToBrowser', 'smartFetchCookies', 'autoScan', 'captureNetwork', 'clearOnNavigation', 'notifications']) $(`#${key}`).checked = Boolean(state.settings[key]);
}

function collectSettingsForm() {
  return {
    ...state.settings,
    downloadFolder: $('#downloadFolder').value.trim() || 'NebulaGrab',
    maxItemsPerTab: Math.max(100, Math.min(5000, Number($('#maxItemsPerTab').value) || 1200)),
    helperUrl: $('#helperUrl').value.trim() || 'http://127.0.0.1:17891',
    helperToken: $('#helperToken').value.trim(),
    helperContainer: $('#helperContainer').value,
    smartFetchBrowser: $('#smartFetchBrowser').value || 'opera',
    reliableDownloads: $('#reliableDownloads').checked,
    fallbackToBrowser: $('#fallbackToBrowser').checked,
    smartFetchCookies: $('#smartFetchCookies').checked,
    autoScan: $('#autoScan').checked,
    captureNetwork: $('#captureNetwork').checked,
    clearOnNavigation: $('#clearOnNavigation').checked,
    notifications: $('#notifications').checked
  };
}

async function testHelper(verbose) {
  try {
    if (verbose) $('#helperTestStatus').textContent = 'Testing…';
    const response = await send({ type: 'TEST_HELPER' });
    els.metricHelper.textContent = response.helper.version ? `v${response.helper.version}` : 'Online';
    els.metricHelper.className = 'helper-online';
    if (verbose) $('#helperTestStatus').textContent = `Online. ffmpeg: ${response.helper.ffmpeg ? 'ready' : 'missing'}; yt-dlp: ${response.helper.ytDlpVersion || (response.helper.ytDlp ? 'ready' : 'missing')}; Deno: ${response.helper.deno ? 'ready' : 'missing'}; cache: ${response.helper.cacheDir || 'unknown'}`;
  } catch (error) {
    els.metricHelper.textContent = 'Offline';
    els.metricHelper.className = 'helper-offline';
    if (verbose) $('#helperTestStatus').textContent = error.message;
  }
}

function setStatus(message = '', kind = '') { els.status.textContent = message; els.status.className = `status ${kind}`; }
function qualityScore(item) { return ((item.width || 0) * (item.height || 0)) + ((item.bitrate || 0) * 10) + ((item.size || item.blobSize || 0) / 10); }
function formatQuality(item) { if (item.kind === 'segment') return `${item.segmentCount || 0} fragments`; if (item.width && item.height) return `${item.width}×${item.height}`; if (item.bitrate) return `${Math.round(item.bitrate / 1000)} kbps`; if (item.variants?.length) return `${item.variants.length} variants`; return 'Unknown'; }
function formatBytes(bytes) { if (!bytes) return '0 B'; const units = ['B','KB','MB','GB','TB']; let n = bytes, i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; } return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`; }
function shortKind(kind) { return ({ video: 'VID', audio: 'AUD', hls: 'HLS', dash: 'DASH', segment: 'SEG', blob: 'BLOB' })[kind] || kind.toUpperCase(); }
function hostname(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }
async function send(message) { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || 'Extension request failed.'); return result; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }
function escapeAttr(value) { return escapeHtml(value); }
