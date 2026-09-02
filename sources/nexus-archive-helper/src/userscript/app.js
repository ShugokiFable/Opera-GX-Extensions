(function () {
  'use strict';
  const C = globalThis.NexusArchiveCore;
  const R = globalThis.NexusArchiveResolver;
  const API_KEY_NAME = 'nexusArchiveHelper.apiKey';

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function apiRequest(url) {
    const apiKey = String(GM_getValue(API_KEY_NAME, '') || '').trim();
    if (!apiKey) return Promise.reject({ status: 0, data: { message: 'Add your Nexus Personal API key first.' } });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          apikey: apiKey,
          Accept: 'application/json',
          'Application-Name': 'Nexus Archive Helper Personal',
          'Application-Version': '__VERSION__',
        },
        timeout: 30000,
        onload(response) {
          let data = null;
          try { data = response.responseText ? JSON.parse(response.responseText) : null; }
          catch { data = response.responseText || null; }
          if (response.status >= 200 && response.status < 300) resolve(data);
          else reject({ status: response.status, data, message: response.statusText });
        },
        onerror() { reject({ status: 0, data: { message: 'Network error contacting Nexus API.' } }); },
        ontimeout() { reject({ status: 0, data: { message: 'Nexus API request timed out.' } }); },
      });
    });
  }

  const style = document.createElement('style');
  style.textContent = `
#nah-launch{position:fixed;right:18px;bottom:18px;z-index:2147483645;background:#d98f39;color:#111;border:0;border-radius:10px;padding:10px 14px;font:700 13px system-ui;box-shadow:0 8px 28px #0008;cursor:pointer}
#nah-panel{position:fixed;right:18px;bottom:64px;width:min(520px,calc(100vw - 36px));max-height:78vh;overflow:auto;z-index:2147483646;background:#17191d;color:#f5f5f5;border:1px solid #3a3e46;border-radius:14px;box-shadow:0 18px 60px #000c;font:13px/1.45 system-ui;padding:14px}
#nah-panel[hidden]{display:none} #nah-panel *{box-sizing:border-box} #nah-panel h2{font-size:17px;margin:0 0 10px} #nah-panel .nah-row{display:flex;gap:8px;margin:8px 0} #nah-panel input{width:100%;background:#0f1114;color:#fff;border:1px solid #444a55;border-radius:7px;padding:8px} #nah-panel button,#nah-panel a.nah-btn{border:1px solid #555d69;background:#272b31;color:#fff;border-radius:7px;padding:7px 9px;cursor:pointer;text-decoration:none;white-space:nowrap} #nah-panel button.primary{background:#d98f39;color:#111;border-color:#d98f39;font-weight:700} #nah-panel .muted{color:#aab0b8;font-size:12px} #nah-panel .status{padding:7px 9px;background:#101216;border-radius:7px;margin:8px 0;white-space:pre-wrap} #nah-panel .file{border:1px solid #333842;border-radius:9px;padding:9px;margin:8px 0;background:#111318} #nah-panel .tag{display:inline-block;font-size:10px;font-weight:800;padding:2px 6px;border-radius:999px;background:#733;color:#ffd8d8;margin-right:5px} #nah-panel .tag.old{background:#54451f;color:#ffe7a3} #nah-panel .tag.main{background:#253b54;color:#d8ebff} #nah-panel .file-title{font-weight:700} #nah-panel .file-meta{color:#aab0b8;font-size:11px;margin:3px 0 7px} #nah-panel .warning{color:#ffd18a;font-size:11px;margin:4px 0}`;
  document.documentElement.appendChild(style);

  const launch = document.createElement('button');
  launch.id = 'nah-launch';
  launch.textContent = '🗃 Archive Helper';
  document.body.appendChild(launch);

  const panel = document.createElement('section');
  panel.id = 'nah-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <h2>Nexus Archive Helper</h2>
    <div class="muted">Official Nexus API/archive resolver. API key stays in Tampermonkey storage.</div>
    <div class="nah-row"><input id="nah-key" type="password" autocomplete="off" placeholder="Nexus Personal API key"><button id="nah-save">Save + Test</button></div>
    <div class="muted"><a href="https://www.nexusmods.com/users/myaccount?tab=api%20access" target="_blank" rel="noreferrer" style="color:#e7a85d">Open Nexus API Access</a></div>
    <div class="nah-row"><input id="nah-ref" placeholder="Nexus URL, nxm:// URL, or game:modId:fileId"><button id="nah-find" class="primary">Find files</button></div>
    <div id="nah-status" class="status">Ready.</div>
    <div id="nah-results"></div>`;
  document.body.appendChild(panel);

  const keyInput = panel.querySelector('#nah-key');
  const refInput = panel.querySelector('#nah-ref');
  const status = panel.querySelector('#nah-status');
  const results = panel.querySelector('#nah-results');
  keyInput.value = GM_getValue(API_KEY_NAME, '') || '';
  refInput.value = location.href;

  launch.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) refInput.focus(); });

  function setStatus(text) { status.textContent = text; }

  panel.querySelector('#nah-save').addEventListener('click', async () => {
    const key = keyInput.value.trim();
    GM_setValue(API_KEY_NAME, key);
    if (!key) { setStatus('API key cleared.'); return; }
    setStatus('Testing API key…');
    try {
      const user = await R.validateUser(apiRequest);
      setStatus(`API key OK: ${user.name || `user ${user.id}`} • ${user.premium ? 'Premium' : 'Free account'}`);
    } catch (err) { setStatus(C.errorMessage(err)); }
  });

  async function download(ref, fileId, preferNxm) {
    setStatus(`Resolving download for file ${fileId}…`);
    const out = await R.resolveDownload(ref, fileId, apiRequest);
    if (out.mode === 'direct' && out.url) {
      setStatus(`Direct Nexus CDN link authorized${out.name ? ` (${out.name})` : ''}.`);
      window.open(out.url, '_blank', 'noopener,noreferrer');
    } else if (out.mode === 'website') {
      const url = preferNxm && out.nxmUrl ? out.nxmUrl : out.url;
      setStatus(`Nexus requires its normal user-bound download flow. Opening exact file page.\n${out.reason || ''}`);
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      setStatus(`Nexus did not expose this file for download.\n${out.reason || ''}`);
    }
  }

  function tagClass(statusName) { return statusName === 'OLD_VERSION' ? 'old' : (['ARCHIVED','DELETED'].includes(statusName) ? '' : 'main'); }

  function render(result, ref) {
    const files = result.interesting.length ? result.interesting : result.files;
    const warningHtml = result.warnings.map(w => `<div class="warning">⚠ ${esc(w)}</div>`).join('');
    if (!files.length) {
      results.innerHTML = `${warningHtml}<div class="file">No files were returned for this reference.</div>`;
      return;
    }
    results.innerHTML = warningHtml + files.map((f) => `
      <div class="file">
        <div><span class="tag ${tagClass(f.status)}">${esc(f.status)}</span><span class="file-title">${esc(f.name)}</span></div>
        <div class="file-meta">File ID ${f.fileId}${f.version ? ` • v${esc(f.version)}` : ''}${f.fileName ? ` • ${esc(f.fileName)}` : ''}${f.sizeKb ? ` • ${esc(C.formatSize(f.sizeKb))}` : ''}</div>
        <div class="nah-row">
          <button data-act="download" data-id="${f.fileId}" class="primary">Download</button>
          <button data-act="vortex" data-id="${f.fileId}">Vortex/NXM</button>
          <button data-act="page" data-id="${f.fileId}">Exact Nexus page</button>
        </div>
      </div>`).join('');

    results.querySelectorAll('[data-act]').forEach((button) => button.addEventListener('click', async () => {
      const id = Number(button.dataset.id);
      const act = button.dataset.act;
      try {
        if (act === 'page') window.open(C.websiteFileUrl(ref, id, false), '_blank', 'noopener,noreferrer');
        else await download(ref, id, act === 'vortex');
      } catch (err) { setStatus(C.errorMessage(err)); }
    }));
  }

  panel.querySelector('#nah-find').addEventListener('click', async () => {
    results.innerHTML = '';
    let ref;
    try { ref = C.parseReference(refInput.value); }
    catch (err) { setStatus(err.message); return; }
    setStatus(`Looking up ${ref.game} mod ${ref.modId}${ref.fileId ? `, file ${ref.fileId}` : ''}…`);
    try {
      const result = await R.resolveFiles(ref, apiRequest);
      setStatus(`Found ${result.files.length} unique file record(s); ${result.interesting.length} archived/deleted/old.` + (result.exact ? ` Exact file ${result.exact.fileId} resolved.` : ''));
      render(result, ref);
    } catch (err) { setStatus(C.errorMessage(err)); }
  });
})();
