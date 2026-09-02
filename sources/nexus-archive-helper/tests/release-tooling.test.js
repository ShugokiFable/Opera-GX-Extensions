const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('build stamps package version into every user-visible/API version location', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build.js')], { cwd: root });
  const version = JSON.parse(read('package.json')).version;
  const manifest = JSON.parse(read('dist/extension/manifest.json'));
  const userscript = read('dist/nexus-archive-helper.user.js');
  const background = read('dist/extension/background.js');
  const popup = read('dist/extension/popup.html');

  assert.equal(manifest.version, version);
  assert.match(userscript, new RegExp(`@version\\s+${version.replaceAll('.', '\\.')}`));
  assert.match(background, new RegExp(`Application-Version': '${version.replaceAll('.', '\\.')}'`));
  assert.match(popup, new RegExp(`>v${version.replaceAll('.', '\\.')}<`));
});

test('private signing key path is ignored by git rules', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^private\/signing-key\.pem$/m);
});

test('unsigned release produces extension, userscript, source archive, and checksums', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/release.js'), '--no-crx'], { cwd: root });
  const version = JSON.parse(read('package.json')).version;
  for (const rel of [
    `release/Nexus-Archive-Helper-v${version}-Chromium.zip`,
    `release/Nexus-Archive-Helper-v${version}.user.js`,
    `release/Nexus-Archive-Helper-v${version}-Source.zip`,
    'release/SHA256SUMS.txt',
  ]) {
    assert.ok(fs.statSync(path.join(root, rel)).size > 0, `${rel} should be non-empty`);
  }
});
