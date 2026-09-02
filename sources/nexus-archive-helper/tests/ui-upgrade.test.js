const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../src/core.js');
const C = globalThis.NexusArchiveCore;
const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('maps Nexus categories to clear user-facing statuses', () => {
  assert.equal(C.displayStatus({ status: 'MAIN' }, []), 'AVAILABLE');
  assert.equal(C.displayStatus({ status: 'UPDATE' }, []), 'AVAILABLE');
  assert.equal(C.displayStatus({ status: 'ARCHIVED' }, []), 'ARCHIVED');
  assert.equal(C.displayStatus({ status: 'DELETED' }, []), 'DELETED');
  assert.equal(C.displayStatus({ status: 'UNKNOWN' }, ['File list: Mod not available (HTTP 404)']), 'HIDDEN');
  assert.equal(C.displayStatus({ status: 'UNKNOWN' }, []), 'UNKNOWN');
});

test('formats timestamps and compact references for the UI', () => {
  assert.equal(C.formatDate(1725235200), '2024-09-02');
  assert.equal(C.referenceLabel({ game: 'skyrimspecialedition', modId: 123, fileId: 456 }), 'skyrimspecialedition:123:456');
  assert.equal(C.referenceLabel({ game: 'fallout4', modId: 42 }), 'fallout4:42');
});

test('history merging deduplicates the same lookup and caps length', () => {
  const old = [
    { reference: 'skyrim:1', at: 1 },
    { reference: 'fallout4:2', at: 2 },
  ];
  const merged = C.mergeHistory(old, { reference: 'skyrim:1', at: 3 }, 2);
  assert.deepEqual(merged, [
    { reference: 'skyrim:1', at: 3 },
    { reference: 'fallout4:2', at: 2 },
  ]);
});

test('extension manifest declares polished icon set and context menu capability', () => {
  const manifest = JSON.parse(read('src/extension/manifest.json'));
  assert.equal(manifest.version, '__VERSION__');
  assert.ok(manifest.key && manifest.key.length > 300);
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.equal(manifest.icons['16'], 'icons/icon16.png');
  assert.equal(manifest.icons['128'], 'icons/icon128.png');
  assert.equal(manifest.action.default_icon['32'], 'icons/icon32.png');
});

test('popup contains resolve, history, and settings surfaces plus page scan', () => {
  const html = read('src/extension/popup.html');
  assert.match(html, /data-view="resolve"/);
  assert.match(html, /data-view="history"/);
  assert.match(html, /data-view="settings"/);
  assert.match(html, /id="scanPage"/);
  assert.match(html, /id="resultFilters"/);
  assert.match(html, /id="quota"/);
});

test('content integration has branded launcher and scan feedback panel', () => {
  const js = read('src/extension/content.js');
  const css = read('src/extension/content.css');
  assert.match(js, /Nexus Archive Helper/);
  assert.match(js, /SCAN_PAGE/);
  assert.match(css, /nexus-archive-helper-panel/);
});

test('background supports history, quotas, badges, page scan, and context menu lookup', () => {
  const js = read('src/extension/background.js');
  assert.match(js, /GET_HISTORY/);
  assert.match(js, /CLEAR_HISTORY/);
  assert.match(js, /GET_QUOTA/);
  assert.match(js, /SCAN_PAGE/);
  assert.match(js, /chrome\.action\.setBadgeText/);
  assert.match(js, /chrome\.contextMenus\.create/);
});

test('page-triggered full results use a standalone tab instead of chrome action popup', () => {
  const js = read('src/extension/background.js');
  assert.doesNotMatch(js, /chrome\.action\.openPopup/);
  assert.match(js, /popup\.html\?standalone=1/);
});

test('standalone results mode expands cleanly instead of keeping popup width', () => {
  const js = read('src/extension/popup.js');
  const css = read('src/extension/popup.css');
  assert.match(js, /standalone/);
  assert.match(css, /html\.standalone/);
  assert.match(css, /max-width:\s*980px/);
});

test('content scan error exposes a setup action instead of a false zero-results state', () => {
  const js = read('src/extension/content.js');
  assert.match(js, /Open setup/);
  assert.match(js, /view:\s*'settings'/);
});

test('popup UI renders all requested human-facing statuses', () => {
  const js = read('src/extension/popup.js');
  for (const status of ['AVAILABLE', 'ARCHIVED', 'DELETED', 'HIDDEN', 'UNKNOWN']) {
    assert.match(js, new RegExp(status));
  }
});
