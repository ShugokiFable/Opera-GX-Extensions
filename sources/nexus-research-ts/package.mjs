import { mkdir, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const release = path.join(root, 'release');
await mkdir(release, { recursive: true });
await cp('dist', path.join(release, 'NEXUS-Research'), { recursive: true });
await cp('README.md', path.join(release, 'README.md'));
await cp('PRIVACY.md', path.join(release, 'PRIVACY.md'));
const zip = path.join(release, 'NEXUS-Research-OperaGX-Chrome-MV3.zip');
await rm(zip, { force: true });
execFileSync('zip', ['-qr', zip, 'NEXUS-Research'], { cwd: release });
console.log(`Created ${zip}`);
