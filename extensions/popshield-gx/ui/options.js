'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let toastTimer;

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function label(name, value) {
  if (name === 'gestureWindowMs') return `${(Number(value) / 1000).toFixed(1)} s`;
  if (name === 'opensPerGesture') return `${value} per click`;
  if (name === 'maxOpensPerMinute') return `${value} / min`;
  return String(value);
}

function renderSettings(settings) {
  $$('[data-setting]').forEach((input) => {
    const name = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = Boolean(settings[name]);
    else input.value = settings[name];
    const output = document.querySelector(`[data-output="${name}"]`);
    if (output) output.textContent = label(name, settings[name]);
  });
  $('#allowlist').value = (settings.allowlist || []).join('\n');
}

function renderStats(stats) {
  $('#blocked').textContent = stats.blocked || 0;
  $('#overlays').textContent = stats.overlays || 0;
  $('#lastBlock').textContent = stats.lastBlockAt ? new Date(stats.lastBlockAt).toLocaleTimeString() : '—';
  const reasons = Object.entries(stats.byReason || {}).sort((a, b) => b[1] - a[1]);
  $('#reasons').textContent = reasons.length
    ? `By reason: ${reasons.map(([key, value]) => `${key} ${value}`).join(' · ')}`
    : 'Nothing blocked yet.';
}

async function refresh() {
  try {
    const state = await send({ type: 'PS_GET_STATE' });
    renderSettings(state.settings);
    renderStats(state.stats);
  } catch (error) { toast(error.message); }
}

$$('[data-setting]').forEach((input) => {
  const save = async () => {
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    const result = await send({ type: 'PS_SAVE_SETTINGS', patch: { [input.dataset.setting]: value } });
    renderSettings(result.settings);
    toast('Saved.');
  };
  input.addEventListener(input.type === 'range' ? 'change' : 'input', save);
  if (input.type === 'range') {
    input.addEventListener('input', () => {
      const output = document.querySelector(`[data-output="${input.dataset.setting}"]`);
      if (output) output.textContent = label(input.dataset.setting, input.value);
    });
  }
});

$('#saveAllowlist').addEventListener('click', async () => {
  const allowlist = $('#allowlist').value.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
  const result = await send({ type: 'PS_SAVE_SETTINGS', patch: { allowlist } });
  renderSettings(result.settings);
  toast('Allowed sites saved.');
});

$('#resetStats').addEventListener('click', async () => {
  await send({ type: 'PS_RESET_STATS' });
  refresh();
  toast('Counters reset.');
});

refresh();
