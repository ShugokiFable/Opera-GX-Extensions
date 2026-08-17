import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ['chrome116'],
  legalComments: 'none',
  logLevel: 'info'
};

await Promise.all([
  build({ ...common, entryPoints: ['src/panel.ts'], outfile: 'dist/panel.js', format: 'iife' }),
  build({ ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js', format: 'iife' })
]);

await cp('static', dist, { recursive: true });

const manifest = JSON.parse(await readFile('static/manifest.json', 'utf8'));
manifest.version = JSON.parse(await readFile('package.json', 'utf8')).version;
await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
