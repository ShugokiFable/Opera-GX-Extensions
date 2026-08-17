'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.ok(manifest.content_scripts[0].matches.includes('<all_urls>'));
for (const file of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts[0].js,
  ...manifest.content_scripts[0].css
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
}
console.log('manifest tests passed');
