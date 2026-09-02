const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const extDist = path.join(dist, 'extension');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function stamp(text) { return text.replaceAll('__VERSION__', version); }
function write(rel, data) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
function copyStampedTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyStampedTree(src, dest);
    else if (/\.(?:js|json|html|css|txt)$/i.test(entry.name)) fs.writeFileSync(dest, stamp(fs.readFileSync(src, 'utf8')));
    else fs.copyFileSync(src, dest);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const userscript = [
  stamp(read('src/userscript/meta.txt')).trimEnd(),
  '',
  stamp(read('src/core.js')),
  '',
  stamp(read('src/browser-resolver.js')),
  '',
  stamp(read('src/userscript/app.js')),
  '',
].join('\n');
write('dist/nexus-archive-helper.user.js', userscript);
copyStampedTree(path.join(root, 'src/extension'), extDist);
fs.copyFileSync(path.join(root, 'src/core.js'), path.join(extDist, 'core.js'));
fs.copyFileSync(path.join(root, 'src/browser-resolver.js'), path.join(extDist, 'browser-resolver.js'));
console.log(`Built Tampermonkey userscript and Chromium extension v${version}.`);
