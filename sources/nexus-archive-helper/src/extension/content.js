(() => {
  if (document.getElementById('nexus-archive-helper-launch')) return;
  const root = document.createElement('div');
  root.id = 'nexus-archive-helper-panel';
  root.innerHTML = `<button id="nexus-archive-helper-launch" title="Scan this Nexus page for archived files"><img alt="" src="${chrome.runtime.getURL('icons/icon32.png')}"><span>Nexus Archive Helper</span><b>Scan archives</b></button><div id="nexus-archive-helper-toast" hidden></div>`;
  document.body.appendChild(root);
  const button = root.querySelector('#nexus-archive-helper-launch');
  const toast = root.querySelector('#nexus-archive-helper-toast');
  const original = button.innerHTML;
  button.addEventListener('click', () => {
    button.disabled = true;
    button.querySelector('b').textContent = 'Scanning…';
    chrome.runtime.sendMessage({ type: 'SCAN_PAGE', reference: location.href }, (response) => {
      button.disabled = false;
      button.innerHTML = original;
      if (chrome.runtime.lastError || !response?.ok) {
        const error = response?.error || chrome.runtime.lastError?.message || 'Archive scan failed.';
        toast.hidden = false;
        toast.className = 'nah-error';
        toast.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = 'Archive scan failed';
        const detail = document.createElement('span');
        detail.textContent = error;
        const setup = document.createElement('button');
        setup.type = 'button';
        setup.textContent = 'Open setup';
        setup.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_POPUP', reference: location.href, view: 'settings' }));
        toast.append(title, detail, setup);
        return;
      }
      const result = response.result;
      const archived = result.files.filter((f) => f.status === 'ARCHIVED').length;
      toast.hidden = false;
      toast.className = archived ? 'nah-found' : 'nah-clear';
      toast.innerHTML = `<strong>${archived ? `${archived} archived file${archived === 1 ? '' : 's'} found` : 'No archived files returned'}</strong><span>${result.files.length} total file record${result.files.length === 1 ? '' : 's'} resolved</span><button type="button">Open full results</button>`;
      toast.querySelector('button').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_POPUP', reference: location.href }));
      setTimeout(() => { toast.hidden = true; }, 12000);
    });
  });
})();
