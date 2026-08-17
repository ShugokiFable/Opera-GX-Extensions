'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let settings = {};
let toastTimer;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power >= 3 ? 1 : 0)} ${units[power]}`;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function outputText(name, value) {
  if (name === 'memoryPressurePercent') return `${value}% free RAM`;
  if (name === 'inactiveMinutes') return `${value} min`;
  if (name === 'chatMaxVisibleTurns') return `${value} turns`;
  if (name === 'chatRevealBatch') return `${value} turns`;
  if (name === 'stallSeconds') return `${value} sec`;
  if (name === 'pressureMinIdleMinutes') return Number(value) === 0 ? 'any idle tab' : `idle ${value} min+`;
  if (name === 'pressureCooldownMinutes') return `${value} min between sweeps`;
  return String(value);
}

function renderSettings(next) {
  settings = next;
  $$('[data-setting]').forEach((input) => {
    const name = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = Boolean(settings[name]);
    else input.value = settings[name];
    const output = document.querySelector(`[data-output="${name}"]`);
    if (output) output.textContent = outputText(name, settings[name]);
  });
  $('#whitelist').value = (settings.whitelist || []).join('\n');
}

function renderDownloads(items) {
  const container = $('#downloads');
  container.textContent = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.textContent = 'No active downloads.';
    container.appendChild(p);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'download-item';
    const received = formatBytes(item.bytesReceived || 0);
    const total = item.totalBytes > 0 ? formatBytes(item.totalBytes) : 'unknown size';
    row.innerHTML = `<div><strong></strong><small>${received} / ${total}</small></div><button type="button">${item.paused ? 'Resume' : 'Pause'}</button>`;
    row.querySelector('strong').textContent = item.filename?.split(/[\\/]/).pop() || item.url || `Download ${item.id}`;
    row.querySelector('button').addEventListener('click', async () => {
      await send({ type: 'GX_DOWNLOAD_ACTION', id: item.id, action: item.paused ? 'resume' : 'pause' });
      toast(item.paused ? 'Download resumed.' : 'Download paused.');
      refresh();
    });
    container.appendChild(row);
  }
}

function renderHibernationLog(entries) {
  const container = $('#hibernationLog');
  container.textContent = '';
  if (!entries.length) {
    const p = document.createElement('p');
    p.textContent = 'Nothing hibernated yet.';
    container.appendChild(p);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'download-item';
    row.innerHTML = '<div><strong></strong><small></small></div><button type="button">Restore</button>';
    row.querySelector('strong').textContent = entry.title || entry.host || 'Tab';
    row.querySelector('small').textContent = `${entry.host || ''} • ${new Date(entry.at).toLocaleTimeString()}`;
    row.querySelector('button').addEventListener('click', async () => {
      try {
        await send({ type: 'GX_RESTORE_TAB', id: entry.id });
      } catch (error) {
        toast(error.message);
      }
    });
    container.appendChild(row);
  }
}

async function refresh() {
  try {
    const state = await send({ type: 'GX_GET_STATE' });
    renderHibernationLog(state.hibernationLog || []);
    renderSettings(state.settings);
    $('#memoryPercent').textContent = `${Math.round(state.memory.freePercent)}%`;
    $('#memoryBytes').textContent = `${formatBytes(state.memory.available)} of ${formatBytes(state.memory.capacity)} available`;
    $('#tabCount').textContent = state.tabs.total;
    $('#tabDetail').textContent = `${state.tabs.discarded} hibernated • ${state.stats.tabsDiscarded} total actions`;
    $('#recoveryCount').textContent = state.stats.downloadsRecovered || 0;
    $('#downloadDetail').textContent = `${state.downloads.active} active transfer(s)`;
    renderDownloads(state.downloads.items || []);
  } catch (error) {
    toast(error.message);
  }
}

$$('[data-setting]').forEach((input) => {
  const save = async () => {
    const name = input.dataset.setting;
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    const result = await send({ type: 'GX_SAVE_SETTINGS', patch: { [name]: value } });
    renderSettings(result.settings);
    toast('Setting saved.');
  };
  input.addEventListener(input.type === 'range' ? 'change' : 'input', save);
  if (input.type === 'range') {
    input.addEventListener('input', () => {
      const output = document.querySelector(`[data-output="${input.dataset.setting}"]`);
      if (output) output.textContent = outputText(input.dataset.setting, input.value);
    });
  }
});

$('#saveWhitelist').addEventListener('click', async () => {
  const whitelist = $('#whitelist').value.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
  const result = await send({ type: 'GX_SAVE_SETTINGS', patch: { whitelist } });
  renderSettings(result.settings);
  toast('Whitelist saved.');
});

$('#hibernate').addEventListener('click', async () => {
  const result = await send({ type: 'GX_HIBERNATE_OTHERS' });
  toast(`${result.discarded || 0} tab(s) hibernated.`);
  refresh();
});

$('#clearLog').addEventListener('click', async () => {
  await send({ type: 'GX_CLEAR_HIBERNATION_LOG' });
  refresh();
});

$('#refresh').addEventListener('click', refresh);
refresh();
