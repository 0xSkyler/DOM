import { spawnSync } from 'node:child_process';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const files = await readdir('release');
const probe = executable => {
  const p = spawnSync(process.execPath, ['scripts/desktop-smoke.mjs'], { stdio: 'inherit', env: { ...process.env, DOM_EXECUTABLE_PATH: executable } });
  if (p.status !== 0) throw new Error(`Packaged desktop validation failed (${p.status})`);
};
if (process.platform === 'linux') {
  const appImage = files.find(f => f.endsWith('.AppImage')); const deb = files.find(f => f.endsWith('.deb'));
  if (!appImage || !deb) throw new Error('Missing Linux installers');
  const unpack = resolve('release/appimage-smoke'); await mkdir(unpack, { recursive: true });
  const extraction = spawnSync(resolve('release', appImage), ['--appimage-extract'], { cwd: unpack, stdio: 'ignore' });
  if (extraction.status !== 0) throw new Error('AppImage extraction failed');
  probe(join(unpack, 'squashfs-root/dom'));
  const debRoot = resolve('release/deb-smoke'); await mkdir(debRoot, { recursive: true });
  const debExtraction = spawnSync('dpkg-deb', ['-x', resolve('release', deb), debRoot], { stdio: 'inherit' });
  if (debExtraction.status !== 0) throw new Error('DEB extraction failed');
  probe(join(debRoot, 'opt/DOM/dom'));
  await rm(unpack, { recursive: true, force: true }); await rm(debRoot, { recursive: true, force: true });
} else if (process.platform === 'win32') {
  const exe = files.find(f => f.endsWith('.exe')); if (!exe) throw new Error('Missing EXE installer');
  const target = join(tmpdir(), `DOM-package-smoke-${Date.now()}`);
  const install = spawnSync(resolve('release', exe), ['/S', `/D=${target}`], { stdio: 'inherit' });
  if (install.status !== 0) throw new Error('Windows silent installer failed');
  probe(join(target, 'DOM.exe')); await rm(target, { recursive: true, force: true });
} else throw new Error('Package validation requires Linux or Windows');
