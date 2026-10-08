import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['electron', 'playwright-core', 'exceljs'], sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', bundle: true, external: ['electron'] });
await viteBuild();
