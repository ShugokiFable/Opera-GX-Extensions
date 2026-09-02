const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/core.js');
const C = globalThis.NexusArchiveCore;

test('parses a normal Nexus mod URL with file_id', () => {
  const ref = C.parseReference('https://www.nexusmods.com/skyrimspecialedition/mods/12345?tab=files&file_id=67890');
  assert.deepEqual(ref, { game: 'skyrimspecialedition', modId: 12345, fileId: 67890, key: null, expires: null });
});

test('parses an nxm URL and keeps free-download key and expiry', () => {
  const ref = C.parseReference('nxm://fallout4/mods/42/files/99?key=abc_DEF-12&expires=1999999999&user_id=7');
  assert.equal(ref.game, 'fallout4');
  assert.equal(ref.modId, 42);
  assert.equal(ref.fileId, 99);
  assert.equal(ref.key, 'abc_DEF-12');
  assert.equal(ref.expires, '1999999999');
});

test('parses compact shorthand', () => {
  assert.deepEqual(C.parseReference('cyberpunk2077:777:888'), {
    game: 'cyberpunk2077', modId: 777, fileId: 888, key: null, expires: null,
  });
});

test('builds list and download endpoints', () => {
  const ref = { game: 'skyrim', modId: 10, fileId: 20, key: null, expires: null };
  assert.equal(C.filesUrl(ref), 'https://api.nexusmods.com/v1/games/skyrim/mods/10/files.json');
  assert.equal(C.filesUrl(ref, 7), 'https://api.nexusmods.com/v1/games/skyrim/mods/10/files.json?category=7');
  assert.equal(C.fileInfoUrl(ref, 20), 'https://api.nexusmods.com/v1/games/skyrim/mods/10/files/20.json');
  assert.equal(C.downloadLinkUrl(ref, 20), 'https://api.nexusmods.com/v1/games/skyrim/mods/10/files/20/download_link.json');
  assert.equal(C.downloadLinkUrl({ ...ref, key: 'k', expires: '123' }, 20), 'https://api.nexusmods.com/v1/games/skyrim/mods/10/files/20/download_link.json?key=k&expires=123');
});

test('normalizes categories and sorts archived first', () => {
  const files = [
    { file_id: 1, name: 'Main', category_id: 1, category_name: 'MAIN', uploaded_timestamp: 3 },
    { file_id: 2, name: 'Archive', category_id: 7, category_name: 'ARCHIVED', uploaded_timestamp: 1 },
    { file_id: 3, name: 'Old', category_id: 4, category_name: 'OLD_VERSION', uploaded_timestamp: 2 },
  ].map(C.normalizeFile);
  const sorted = C.sortInteresting(files);
  assert.deepEqual(sorted.map(f => f.fileId), [2, 3, 1]);
  assert.equal(sorted[0].status, 'ARCHIVED');
});

test('merges duplicate file IDs while preserving richer records', () => {
  const merged = C.mergeFiles(
    [{ file_id: 2, name: '', category_id: 7 }],
    [{ file_id: 2, name: 'Archive build', file_name: 'archive.7z', category_name: 'ARCHIVED' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'Archive build');
  assert.equal(merged[0].fileName, 'archive.7z');
  assert.equal(merged[0].status, 'ARCHIVED');
});

test('builds official website fallback for a specific file', () => {
  const url = C.websiteFileUrl({ game: 'skyrimspecialedition', modId: 123, fileId: 456 }, 456, false);
  assert.equal(url, 'https://www.nexusmods.com/skyrimspecialedition/mods/123?tab=files&file_id=456&nmm=0');
});

test('extracts readable API errors', () => {
  assert.equal(C.errorMessage({ status: 403, data: { message: 'Premium only' } }), 'Premium only (HTTP 403)');
  assert.match(C.errorMessage({ status: 404, data: null }), /HTTP 404/);
});
