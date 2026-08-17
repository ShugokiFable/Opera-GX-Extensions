'use strict';

const $ = (selector) => document.querySelector(selector);

function setStatus(text) { $('#status').textContent = text; }

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function render(state) {
  $('#enabled').checked = Boolean(state.settings.enabled);
  $('#tabBlocked').textContent = state.tabBlocked || 0;
  $('#totalBlocked').textContent = state.stats.blocked || 0;
  $('#siteHost').textContent = state.site.host || 'No web page in focus';
  $('#siteAllowed').checked = Boolean(state.site.allowed);
  $('#siteAllowed').disabled = !state.site.host;
  document.querySelectorAll('[data-setting]').forEach((input) => {
    input.checked = Boolean(state.settings[input.dataset.setting]);
  });
}

async function refresh() {
  try { render(await send({ type: 'PS_GET_STATE' })); }
  catch (error) { setStatus(error.message); }
}

$('#enabled').addEventListener('change', async (event) => {
  await send({ type: 'PS_SAVE_SETTINGS', patch: { enabled: event.target.checked } });
  setStatus(event.target.checked ? 'Shield up.' : 'Shield down.');
  refresh();
});

document.querySelectorAll('[data-setting]').forEach((input) => {
  input.addEventListener('change', async () => {
    await send({ type: 'PS_SAVE_SETTINGS', patch: { [input.dataset.setting]: input.checked } });
    setStatus('Saved.');
  });
});

$('#siteAllowed').addEventListener('change', async (event) => {
  try {
    const result = await send({ type: 'PS_SET_SITE', allowed: event.target.checked });
    setStatus(result.allowed ? `Popups allowed on ${result.host}.` : `Popups blocked on ${result.host}.`);
  } catch (error) { setStatus(error.message); }
  refresh();
});

$('#kill').addEventListener('click', async () => {
  try {
    const result = await send({ type: 'PS_KILL_OVERLAY' });
    setStatus(result.removed ? `Removed ${result.removed} overlay(s).` : 'No blocking overlay found.');
  } catch (error) { setStatus(error.message); }
});

$('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
