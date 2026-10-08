import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
export default defineConfig(({ command }) => {
  const nonce = randomBytes(18).toString('base64');
  return { root: 'src/renderer', base: './', plugins: [react(), ...(command === 'serve' ? [{ name: 'desktop-dev-csp', transformIndexHtml: (html: string) => html.replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`) }] : [])],
    html: command === 'serve' ? { cspNonce: nonce } : undefined,
    build: { outDir: '../../dist/renderer', emptyOutDir: true },
    server: { host: '127.0.0.1', port: 5173, strictPort: true } };
});
