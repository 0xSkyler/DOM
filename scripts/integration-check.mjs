import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
const require = createRequire(import.meta.url);
await mkdir('test-results', { recursive: true });
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const child = spawn(process.execPath, [cli, 'run', 'src/tests/integration', '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=test-results/integration.json'], { stdio: 'inherit' });
child.on('exit', async code => {
  if (code !== 0 && process.env.GITHUB_ACTIONS) {
    try {
      const results = JSON.parse(await readFile('test-results/integration.json', 'utf8'));
      for (const file of results.testResults ?? []) for (const test of file.assertionResults ?? []) if (test.status === 'failed') {
        const message = `${test.fullName}: ${(test.failureMessages ?? []).join('\n')}`.replace(/\u001b\[[0-9;]*m/g, '').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
        console.error(`::error file=src/tests/integration/lifecycle.test.ts,title=Integration test failed::${message.slice(0, 12000)}`);
      }
    } catch (error) { console.error('Integration result report unavailable:', error.message); }
  }
  process.exitCode = code ?? 1;
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
