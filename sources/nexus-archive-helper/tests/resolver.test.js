const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/core.js');
require('../src/browser-resolver.js');
const C = globalThis.NexusArchiveCore;
const R = globalThis.NexusArchiveResolver;

function fakeRequester(routes) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (!(url in routes)) throw { status: 404, data: { message: 'missing route' } };
    const value = routes[url];
    if (value && value.__error) throw value.__error;
    return value;
  };
  request.calls = calls;
  return request;
}

test('resolveFiles merges direct exact-file lookup with richer data from the complete file list', async () => {
  const ref = C.parseReference('skyrimspecialedition:100:777');
  const request = fakeRequester({
    [C.fileInfoUrl(ref, 777)]: { file_id: 777, name: 'Exact', category_id: 7 },
    [C.filesUrl(ref)]: { files: [
      { file_id: 1, name: 'Main', category_id: 1 },
      { file_id: 777, name: 'Exact richer', file_name: 'exact.7z', category_name: 'ARCHIVED' },
      { file_id: 44, name: 'Old', category_id: 4 },
    ] },
  });

  const result = await R.resolveFiles(ref, request);
  assert.equal(result.exact.fileId, 777);
  assert.equal(result.exact.fileName, 'exact.7z');
  assert.deepEqual(result.interesting.map(f => f.fileId), [777, 44]);
});

test('resolveFiles survives a hidden/unavailable mod list when exact file lookup works', async () => {
  const ref = C.parseReference('fallout4:12:99');
  const request = fakeRequester({
    [C.fileInfoUrl(ref, 99)]: { file_id: 99, name: 'Hidden archive', category_id: 7 },
    [C.filesUrl(ref)]: { __error: { status: 404, data: { message: 'Mod not available' } } },
  });

  const result = await R.resolveFiles(ref, request);
  assert.equal(result.files.length, 1);
  assert.equal(result.exact.status, 'ARCHIVED');
  assert.ok(result.warnings.length >= 1);
});

test('resolveFiles throws when every Nexus API request fails instead of pretending there are zero files', async () => {
  const ref = C.parseReference('skyrimspecialedition:145439');
  const request = fakeRequester({
    [C.filesUrl(ref)]: { __error: { status: 401, data: { message: 'Invalid API key' } } },
  });

  await assert.rejects(
    () => R.resolveFiles(ref, request),
    /Invalid API key.*HTTP 401/i,
  );
});

test('resolveFiles gets archived records from the complete file list without redundant category requests', async () => {
  const ref = C.parseReference('skyrimspecialedition:145439');
  const request = fakeRequester({
    [C.filesUrl(ref)]: {
      files: [
        { file_id: 1, name: 'Current file', category_id: 1 },
        { file_id: 2, name: 'Archived file', category_id: 7 },
      ],
    },
  });

  const result = await R.resolveFiles(ref, request);
  assert.equal(result.files.length, 2);
  assert.equal(result.interesting[0].fileId, 2);
  assert.deepEqual(request.calls, [C.filesUrl(ref)]);
});

test('resolveDownload returns direct CDN URI when Nexus authorizes it', async () => {
  const ref = C.parseReference('skyrim:10:20');
  const request = fakeRequester({
    [C.downloadLinkUrl(ref, 20)]: [{ URI: 'https://cdn.example/file.7z', name: 'CDN' }],
  });
  const result = await R.resolveDownload(ref, 20, request);
  assert.equal(result.mode, 'direct');
  assert.equal(result.url, 'https://cdn.example/file.7z');
});

test('resolveDownload falls back to official Nexus file page on 403', async () => {
  const ref = C.parseReference('skyrim:10:20');
  const request = fakeRequester({
    [C.downloadLinkUrl(ref, 20)]: { __error: { status: 403, data: { message: 'Premium users only' } } },
  });
  const result = await R.resolveDownload(ref, 20, request);
  assert.equal(result.mode, 'website');
  assert.match(result.url, /file_id=20/);
  assert.match(result.reason, /Premium users only/);
});

test('validateUser recognizes premium flag variants', async () => {
  const request = fakeRequester({
    'https://api.nexusmods.com/v1/users/validate.json': { user_id: 5, name: 'Test', is_premium: true },
  });
  const user = await R.validateUser(request);
  assert.deepEqual(user, { id: 5, name: 'Test', premium: true });
});
