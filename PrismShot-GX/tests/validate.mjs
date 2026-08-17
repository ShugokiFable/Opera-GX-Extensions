import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

assert(manifest.manifest_version === 3, 'Manifest must use version 3.');
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Version must be semantic x.y.z.');
assert(manifest.background?.service_worker && exists(manifest.background.service_worker), 'Background service worker is missing.');
assert(manifest.action?.default_popup && exists(manifest.action.default_popup), 'Popup page is missing.');
assert(manifest.options_page && exists(manifest.options_page), 'Options page is missing.');
assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0, 'Content script declaration is missing.');

for (const contentScript of manifest.content_scripts || []) {
  for (const file of [...(contentScript.js || []), ...(contentScript.css || [])]) {
    assert(exists(file), `Declared content-script file is missing: ${file}`);
  }
}
for (const [size, icon] of Object.entries(manifest.icons || {})) {
  assert(exists(icon), `Icon ${size} is missing: ${icon}`);
}

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(root);

for (const file of files.filter((file) => file.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`JavaScript syntax failed: ${path.relative(root, file)}\n${error.stderr?.toString() || error.message}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  assert(!/\beval\s*\(/.test(source), `eval() is forbidden: ${path.relative(root, file)}`);
  assert(!/new\s+Function\s*\(/.test(source), `new Function() is forbidden: ${path.relative(root, file)}`);
  assert(!/https?:\/\//.test(source), `Remote URL found in runtime JavaScript: ${path.relative(root, file)}`);
}

for (const file of files.filter((file) => file.endsWith('.html'))) {
  const html = fs.readFileSync(file, 'utf8');
  assert(!/<script(?![^>]*\bsrc=)[^>]*>\s*[^<\s]/i.test(html), `Inline executable script found: ${path.relative(root, file)}`);
  assert(!/<script[^>]+src=["']https?:\/\//i.test(html), `Remote script found: ${path.relative(root, file)}`);
}

if (failures.length) {
  console.error(`Validation failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`PrismShot GX validation passed: ${files.length} files checked.`);
