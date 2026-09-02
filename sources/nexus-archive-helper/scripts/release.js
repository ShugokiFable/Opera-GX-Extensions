const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { zipDirectory, packCrx, copySourceTree } = require('./lib/release-utils');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const args = process.argv.slice(2);
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const noCrx = args.includes('--no-crx');
const keyPath = path.resolve(root, valueAfter('--key') || path.join('private', 'signing-key.pem'));
const releaseDir = path.join(root, 'release');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-archive-helper-release-'));

function runNode(script) {
  const out = spawnSync(process.execPath, [path.join(root, script)], { cwd: root, stdio: 'inherit' });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`${script} failed with exit code ${out.status}`);
}
function copy(from, to) { fs.copyFileSync(from, to); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

runNode('scripts/build.js');
runNode('scripts/verify-build.js');
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

const extensionZip = path.join(releaseDir, `Nexus-Archive-Helper-v${version}-Chromium.zip`);
zipDirectory(path.join(root, 'dist', 'extension'), extensionZip);
const userOut = path.join(releaseDir, `Nexus-Archive-Helper-v${version}.user.js`);
copy(path.join(root, 'dist', 'nexus-archive-helper.user.js'), userOut);

const stagedSource = path.join(tempDir, `Nexus-Archive-Helper-v${version}-Source`);
copySourceTree(root, stagedSource);
const sourceZip = path.join(releaseDir, `Nexus-Archive-Helper-v${version}-Source.zip`);
zipDirectory(stagedSource, sourceZip);

const outputs = [extensionZip, userOut, sourceZip];
if (!noCrx) {
  const packed = packCrx(path.join(root, 'dist', 'extension'), keyPath);
  const crxOut = path.join(releaseDir, `Nexus-Archive-Helper-v${version}.crx`);
  copy(packed, crxOut);
  outputs.push(crxOut);
}

const sums = outputs.map((file) => `${sha256(file)}  ${path.basename(file)}`).join('\n') + '\n';
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), sums);
fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`Release v${version} ready in ${releaseDir}`);
for (const file of outputs) console.log(` - ${path.basename(file)}`);
console.log(' - SHA256SUMS.txt');
