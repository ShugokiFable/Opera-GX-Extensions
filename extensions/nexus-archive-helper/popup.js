const C = globalThis.NexusArchiveCore;
const standalone = new URLSearchParams(location.search).get('standalone') === '1';
if (standalone) document.documentElement.classList.add('standalone');
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const reference = $('#reference');
const apiKey = $('#apiKey');
const statusLine = $('#status');
const statusText = $('#statusText');
const resultsEl = $('#results');
const resultsSection = $('#resultsSection');
const emptyState = $('#emptyState');
const warningsEl = $('#warnings');
const filtersEl = $('#resultFilters');
const resultsMeta = $('#resultsMeta');
const quotaEl = $('#quota');
let currentResult = null;
let currentFilter = 'ALL';

const HUMAN_STATUSES = ['AVAILABLE', 'ARCHIVED', 'OLD_VERSION', 'DELETED', 'HIDDEN', 'UNKNOWN'];

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!response || !response.ok) return reject(new Error(response?.error || 'Extension request failed.'));
    resolve(response);
  }));
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(message,tone='neutral'){statusText.textContent=message;statusLine.dataset.tone=tone;}
function displayStatus(file,result=currentResult){return C.displayStatus(file,result?.warnings||[]);}
function statusClass(value){return `status-${String(value||'UNKNOWN').toLowerCase()}`;}
function setView(name){$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='history')loadHistory();}
function updateQuota(q){if(!q){quotaEl.textContent='API · --';quotaEl.className='quota';return;}const h=q.hourlyRemaining,d=q.dailyRemaining;if(h==null&&d==null){quotaEl.textContent='API · OK';quotaEl.className='quota good';return;}quotaEl.textContent=`API · ${h??'--'}/hr`;quotaEl.title=`Hourly remaining: ${h??'unknown'}${q.hourlyLimit!=null?` / ${q.hourlyLimit}`:''}\nDaily remaining: ${d??'unknown'}${q.dailyLimit!=null?` / ${q.dailyLimit}`:''}`;quotaEl.className=`quota ${(h!=null&&h<50)||(d!=null&&d<500)?'low':'good'}`;}
async function currentTabUrl(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return tab?.url||'';}
async function openUrl(url){if(url)await chrome.tabs.create({url});}

function renderFilters(){
  if(!currentResult)return;
  const counts={ALL:currentResult.files.length};
  for(const s of HUMAN_STATUSES)counts[s]=0;
  currentResult.files.forEach(f=>{const s=displayStatus(f);counts[s]=(counts[s]||0)+1;});
  filtersEl.innerHTML=['ALL',...HUMAN_STATUSES].filter(s=>s==='ALL'||counts[s]).map(s=>`<button class="filter ${s===currentFilter?'active':''}" data-filter="${s}">${s.replace('_VERSION','')}<span class="count">${counts[s]}</span></button>`).join('');
  filtersEl.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{currentFilter=b.dataset.filter;renderFilters();renderFiles();}));
}

function renderFiles(){
  if(!currentResult)return;
  const files=currentResult.files.filter(f=>currentFilter==='ALL'||displayStatus(f)===currentFilter);
  resultsMeta.textContent=`${files.length} shown · ${currentResult.files.length} total`;
  if(!files.length){resultsEl.innerHTML='<div class="history-empty">Nothing in this filter.</div>';return;}
  resultsEl.innerHTML=files.map(f=>{
    const s=displayStatus(f);
    const date=C.formatDate(f.uploadedTimestamp);
    const size=C.formatSize(f.sizeKb);
    return `<article class="file-row" data-file-id="${f.fileId}">
      <div class="file-top"><div class="file-main">
        <div class="file-title-line"><span class="status-chip ${statusClass(s)}">${esc(s.replace('_VERSION',' OLD'))}</span><span class="file-title" title="${esc(f.name)}">${esc(f.name)}</span></div>
        <div class="file-meta"><span>File <b>#${f.fileId}</b></span>${f.version?`<span>Version <b>${esc(f.version)}</b></span>`:''}${size?`<span>Size <b>${esc(size)}</b></span>`:''}${date?`<span>Uploaded <b>${esc(date)}</b></span>`:''}<span>Category <b>${esc(f.status)}</b></span></div>
        ${f.fileName?`<div class="file-name" title="${esc(f.fileName)}">${esc(f.fileName)}</div>`:''}
      </div></div>
      <div class="file-actions"><button class="download" data-action="download" data-id="${f.fileId}">Download</button><button data-action="vortex" data-id="${f.fileId}">Vortex / NXM</button><button data-action="page" data-id="${f.fileId}">Exact page</button></div>
    </article>`;
  }).join('');
  resultsEl.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',async()=>{
    try{
      const id=Number(b.dataset.id),action=b.dataset.action;
      if(action==='page'){const r=currentResult.ref;await openUrl(C.websiteFileUrl(r,id,false));return;}
      await doDownload(id,action==='vortex');
    }catch(e){setStatus(e.message,'error');}
  }));
}

function renderResult(result){
  currentResult=result;currentFilter='ALL';
  emptyState.classList.add('hidden');resultsSection.classList.remove('hidden');
  const archived=result.files.filter(f=>displayStatus(f,result)==='ARCHIVED').length;
  $('#resultsTitle').textContent=archived?`${archived} archived file${archived===1?'':'s'} found`:'Files found';
  warningsEl.innerHTML=(result.warnings||[]).map(w=>`<div class="warning">${esc(w)}</div>`).join('');
  renderFilters();renderFiles();
}

async function resolveReference(value){
  const input=String(value||reference.value||'').trim();
  if(!input){setStatus('Paste a Nexus reference first.','error');return;}
  reference.value=input;setStatus('Querying Nexus file records…','busy');
  try{
    const r=await send({type:'RESOLVE',reference:input});updateQuota(r.quota);renderResult(r.result);
    const archived=r.result.files.filter(f=>displayStatus(f,r.result)==='ARCHIVED').length;
    const hidden=r.result.files.filter(f=>displayStatus(f,r.result)==='HIDDEN').length;
    const bits=[`${r.result.files.length} unique file record${r.result.files.length===1?'':'s'}`];if(archived)bits.push(`${archived} archived`);if(hidden)bits.push(`${hidden} hidden-page`);if(r.result.exact)bits.push(`exact #${r.result.exact.fileId} resolved`);
    setStatus(bits.join(' · '),'ok');
  }catch(e){setStatus(e.message,'error');}
}

async function doDownload(fileId,preferNxm){
  setStatus(`Resolving download authorization for file #${fileId}…`,'busy');
  const r=await send({type:'DOWNLOAD',reference:reference.value,fileId});updateQuota(r.quota);const d=r.result;
  if(d.mode==='direct'&&d.url){setStatus(`Direct Nexus CDN link authorized for #${fileId}.`,'ok');await openUrl(d.url);return;}
  if(d.mode==='website'){setStatus('Direct CDN access was not authorized; opening Nexus official download flow.','ok');await openUrl(preferNxm&&d.nxmUrl?d.nxmUrl:d.url);return;}
  setStatus(`Nexus no longer exposes a download for file #${fileId}. ${d.reason||''}`,'error');
}

async function loadHistory(){
  try{
    const r=await send({type:'GET_HISTORY'});const list=r.history||[];const el=$('#historyList');
    if(!list.length){el.innerHTML='<div class="history-empty">No archive footprints yet.<br>Resolved references will appear here.</div>';return;}
    el.innerHTML=list.map((h,i)=>`<div class="history-item" data-index="${i}"><div><div class="history-ref">${esc(h.reference)}</div><div class="history-time">${new Date(h.at).toLocaleString()}</div><div class="history-stats">${h.total||0} files · ${h.archived||0} archived${h.exactFileId?` · exact #${h.exactFileId}`:''}</div></div><div class="history-badge">RESOLVE ›</div></div>`).join('');
    el.querySelectorAll('[data-index]').forEach(row=>row.addEventListener('click',()=>{const h=list[Number(row.dataset.index)];reference.value=h.reference;setView('resolve');resolveReference(h.reference);}));
  }catch(e){$('#historyList').innerHTML=`<div class="history-empty">${esc(e.message)}</div>`;}
}

async function validateKey(){
  const card=$('#accountStatus');
  try{
    await send({type:'SAVE_KEY',apiKey:apiKey.value});
    if(!apiKey.value.trim()){card.className='account-card';card.innerHTML='<span class="account-light"></span><div><strong>API key cleared</strong><small>Add a Personal API key to query Nexus.</small></div>';setStatus('API key cleared.');return;}
    setStatus('Validating Nexus API key…','busy');const r=await send({type:'VALIDATE'});updateQuota(r.quota);
    card.className='account-card ok';card.innerHTML=`<span class="account-light"></span><div><strong>${esc(r.user.name||`Nexus user ${r.user.id}`)} · ${r.user.premium?'Premium':'Free'}</strong><small>API key validated successfully. Downloads follow your Nexus account permissions.</small></div>`;setStatus('Nexus API key validated.','ok');
  }catch(e){card.className='account-card bad';card.innerHTML=`<span class="account-light"></span><div><strong>API key failed validation</strong><small>${esc(e.message)}</small></div>`;setStatus(e.message,'error');}
}

$$('.tab').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
$('#find').addEventListener('click',()=>resolveReference());
reference.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();resolveReference();}});
$('#scanPage').addEventListener('click',async()=>{const url=await currentTabUrl();if(!/nexusmods\.com/i.test(url)){setStatus('The active tab is not a Nexus Mods page.','error');return;}reference.value=url;resolveReference(url);});
$('#copyReference').addEventListener('click',async()=>{if(!currentResult)return;await navigator.clipboard.writeText(C.referenceLabel(currentResult.ref));setStatus('Compact Nexus reference copied.','ok');});
$('#saveKey').addEventListener('click',validateKey);
$('#toggleKey').addEventListener('click',()=>{apiKey.type=apiKey.type==='password'?'text':'password';});
$('#apiLink').addEventListener('click',()=>openUrl('https://www.nexusmods.com/users/myaccount?tab=api%20access'));
$('#clearHistory').addEventListener('click',async()=>{await send({type:'CLEAR_HISTORY'});loadHistory();});

(async()=>{
  try{
    const saved=await send({type:'GET_KEY'});apiKey.value=saved.apiKey||'';updateQuota(saved.quota);
    const {pendingReference='',pendingView=''}=await chrome.storage.local.get(['pendingReference','pendingView']);
    if(pendingReference)reference.value=pendingReference;
    if(['resolve','history','settings'].includes(pendingView))setView(pendingView);
    if(pendingReference||pendingView)await chrome.storage.local.remove(['pendingReference','pendingView']);
    else {const url=await currentTabUrl();if(/nexusmods\.com/i.test(url))reference.value=url;}
  }catch(e){setStatus(e.message,'error');}
})();
