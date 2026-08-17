'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power >= 3 ? 1 : 0)} ${units[power]}`;
}

function setStatus(text, kind = '') {
  const node = $('#status');
  node.textContent = text;
  node.className = `status ${kind}`.trim();
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function render(state) {
  const free = Math.max(0, Math.min(100, state.memory?.freePercent || 0));
  $('#memoryRing').style.setProperty('--p', free.toFixed(1));
  $('#memoryPercent').textContent = Math.round(free);
  $('#memoryText').textContent = `${formatBytes(state.memory?.available)} of ${formatBytes(state.memory?.capacity)} available`;
  $('#tabText').textContent = `${state.tabs.total} tabs • ${state.tabs.discarded} already hibernated`;
  $('#discarded').textContent = state.stats.tabsDiscarded || 0;
  $('#recovered').textContent = state.stats.downloadsRecovered || 0;
  $('#activeDownloads').textContent = state.downloads.active || 0;
  $('#enabled').checked = Boolean(state.settings.enabled);
  $$('[data-setting]').forEach((input) => {
    input.checked = Boolean(state.settings[input.dataset.setting]);
  });
  const host = state.site?.host;
  $('#siteHost').textContent = host || 'No web page in focus';
  $('#siteProtect').checked = Boolean(state.site?.protected);
  $('#siteProtect').disabled = !host;
}

async function refresh() {
  try {
    render(await send({ type: 'GX_GET_STATE' }));
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

$('#enabled').addEventListener('change', async (event) => {
  await send({ type: 'GX_SAVE_SETTINGS', patch: { enabled: event.target.checked } });
  setStatus(event.target.checked ? 'Overdrive engaged.' : 'Overdrive parked.', 'ok');
  refresh();
});

$$('[data-setting]').forEach((input) => {
  input.addEventListener('change', async () => {
    await send({ type: 'GX_SAVE_SETTINGS', patch: { [input.dataset.setting]: input.checked } });
    setStatus('Setting saved.', 'ok');
  });
});

$('#siteProtect').addEventListener('change', async (event) => {
  try {
    const result = await send({ type: 'GX_SET_SITE_PROTECTION', protected: event.target.checked });
    setStatus(result.protected ? `${result.host} will never hibernate.` : `${result.host} can hibernate again.`, 'ok');
    refresh();
  } catch (error) {
    setStatus(error.message, 'error');
    refresh();
  }
});

$('#boost').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'GX_BOOST_ACTIVE' });
    setStatus(result.response?.hidden ? `${result.response.hidden} old chat turns folded.` : 'Current page optimized.', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

$('#hibernate').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'GX_HIBERNATE_OTHERS' });
    setStatus(`${result.discarded || 0} background tab(s) hibernated.`, 'ok');
    refresh();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

$('#repair').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'GX_REPAIR_SITE' });
    setStatus(`Rebuilt cache path for ${result.origin}. Reload the page.`, 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

$('#dashboard').addEventListener('click', () => send({ type: 'GX_OPEN_DASHBOARD' }));

refresh();
