'use strict';

let activeTab = null;
let items = [];
let currentFilter = 'all';

const els = {
  pageTitle: document.querySelector('#pageTitle'),
  totalCount: document.querySelector('#totalCount'),
  videoCount: document.querySelector('#videoCount'),
  imageCount: document.querySelector('#imageCount'),
  mediaList: document.querySelector('#mediaList'),
  status: document.querySelector('#status')
};

init().catch((error) => setStatus(error.message, 'error'));

async function init() {
  const response = await send({ type: 'GET_ACTIVE_TAB' });
  activeTab = response.tab;
  if (!activeTab) throw new Error('No active tab found.');
  els.pageTitle.textContent = activeTab.title || activeTab.url || 'Active tab';
  await refresh();
}

async function refresh() {
  const response = await send({ type: 'GET_ITEMS', tabId: activeTab.id });
  items = response.items || [];
  const stats = response.stats || {};
  els.totalCount.textContent = stats.total || 0;
  els.videoCount.textContent = (stats.video || 0) + (stats.hls || 0) + (stats.dash || 0) + (stats.segment || 0) + (stats.blob || 0);
  els.imageCount.textContent = stats.image || 0;
  render();
}

function render() {
  const filtered = items.filter(matchesFilter).slice(0, 100);
  if (!filtered.length) {
    els.mediaList.innerHTML = '<div class="empty"><strong>No media yet</strong>Play the video or scroll the page, then press Scan.</div>';
    return;
  }

  els.mediaList.innerHTML = filtered.map((item) => `
    <article class="media-row" data-id="${escapeHtml(item.id)}">
      <div class="thumb">${item.kind === 'image' ? `<img src="${escapeAttr(item.url)}" alt="">` : escapeHtml(shortKind(item.kind))}</div>
      <div class="media-main">
        <div class="media-name" title="${escapeAttr(item.filename)}">${escapeHtml(item.filename || 'media')}</div>
        <div class="media-meta">
          <span class="badge badge-${escapeHtml(item.kind)}">${escapeHtml(item.kind)}</span>
          <span>${escapeHtml(formatQuality(item))}</span>
          <span>${escapeHtml(formatBytes(item.size || item.blobSize))}</span>
          ${item.drm || item.encrypted ? '<span class="badge badge-danger">blocked</span>' : ''}
        </div>
      </div>
      <div class="media-actions">
        <button class="btn download-btn" title="Download">↓</button>
      </div>
    </article>
  `).join('');
}

document.querySelector('#scanBtn').addEventListener('click', async () => {
  setStatus('Scanning page…');
  try {
    await send({ type: 'SCAN_TAB', tabId: activeTab.id });
    setTimeout(() => refresh().catch(() => {}), 650);
    setStatus('Scan dispatched.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
});

document.querySelector('#smartFetchBtn').addEventListener('click', async () => {
  const button = document.querySelector('#smartFetchBtn');
  button.disabled = true;
  setStatus('Starting Smart Fetch…');
  try {
    const result = await send({ type: 'SMART_FETCH_PAGE', tabId: activeTab.id });
    setStatus(`Smart Fetch job ${result.jobId} started.`, 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { button.disabled = false; }
});

document.querySelector('#dashboardBtn').addEventListener('click', async () => {
  await send({ type: 'OPEN_DASHBOARD', tabId: activeTab?.id });
  window.close();
});

document.querySelector('#clearBtn').addEventListener('click', async () => {
  await send({ type: 'CLEAR_TAB', tabId: activeTab.id });
  await refresh();
  setStatus('Capture list cleared.', 'success');
});

document.querySelector('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-kind]');
  if (!button) return;
  currentFilter = button.dataset.kind;
  document.querySelectorAll('#filters .pill').forEach((pill) => pill.classList.toggle('active', pill === button));
  render();
});

els.mediaList.addEventListener('click', async (event) => {
  const button = event.target.closest('.download-btn');
  if (!button) return;
  const row = button.closest('[data-id]');
  button.disabled = true;
  setStatus('Starting download…');
  try {
    const result = await send({ type: 'DOWNLOAD_ITEM', tabId: activeTab.id, id: row.dataset.id });
    setStatus(result.mode === 'helper' ? `Companion job ${result.jobId} started.` : 'Download started.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { button.disabled = false; }
});

function matchesFilter(item) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'stream') return ['hls', 'dash', 'segment', 'blob'].includes(item.kind);
  return item.kind === currentFilter;
}

function setStatus(message = '', kind = '') {
  els.status.textContent = message;
  els.status.className = `status ${kind}`;
}

function formatQuality(item) {
  if (item.kind === 'segment') return `${item.segmentCount || 0} fragments`;
  if (item.width && item.height) return `${item.width}×${item.height}`;
  if (item.bitrate) return `${Math.round(item.bitrate / 1000)} kbps`;
  return item.source || '';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function shortKind(kind) { return ({ video: 'VID', audio: 'AUD', hls: 'HLS', dash: 'DASH', segment: 'SEG', blob: 'BLOB' })[kind] || kind.toUpperCase(); }
async function send(message) { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error || 'Extension request failed.'); return result; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }
function escapeAttr(value) { return escapeHtml(value); }
