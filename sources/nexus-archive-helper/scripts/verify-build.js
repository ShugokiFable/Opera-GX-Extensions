const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
function must(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) throw new Error(`Missing build artifact: ${rel}`);
  if (!fs.statSync(p).size) throw new Error(`Empty build artifact: ${rel}`);
  return p;
}
const user = fs.readFileSync(must('dist/nexus-archive-helper.user.js'), 'utf8');
if (!user.startsWith('// ==UserScript==')) throw new Error('Userscript metadata header missing.');
if (!user.includes('@connect      api.nexusmods.com')) throw new Error('Userscript Nexus API connect permission missing.');
if (!new RegExp(`@version\\s+${version.replaceAll('.', '\\.')}\\b`).test(user)) throw new Error('Userscript version is not synchronized.');
const manifest = JSON.parse(fs.readFileSync(must('dist/extension/manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Extension must be Manifest V3.');
if (manifest.version !== version) throw new Error(`Unexpected extension version: ${manifest.version}; expected ${version}.`);
for (const rel of ['background.js', 'core.js', 'browser-resolver.js', 'popup.html', 'popup.js', 'popup.css', 'content.js', 'content.css']) must(`dist/extension/${rel}`);
for (const size of [16, 32, 48, 128]) must(`dist/extension/icons/icon${size}.png`);
if (!manifest.permissions.includes('contextMenus')) throw new Error('Context menu permission missing.');
if (!manifest.action?.default_icon?.['32']) throw new Error('Toolbar icon declaration missing.');
const background = fs.readFileSync(must('dist/extension/background.js'), 'utf8');
if (!background.includes(`'Application-Version': '${version}'`)) throw new Error('Extension API version header is not synchronized.');
const popup = fs.readFileSync(must('dist/extension/popup.html'), 'utf8');
if (!popup.includes(`>v${version}<`)) throw new Error('Popup version label is not synchronized.');
console.log(`Build verification passed for v${version}: manifest, scripts, UI, version stamps, and icon set present.`);
