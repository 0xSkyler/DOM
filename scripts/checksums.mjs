import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const names = (await readdir('release')).filter(f => /\.(exe|AppImage|deb)$/.test(f));
if (!names.length) throw new Error('No release binaries');
const rows = await Promise.all(names.map(async file => `${createHash('sha256').update(await readFile(`release/${file}`)).digest('hex')}  ${file}`));
await writeFile(`release/${process.platform}-SHA256SUMS.txt`, rows.join('\n') + '\n');
console.log(rows.join('\n'));
