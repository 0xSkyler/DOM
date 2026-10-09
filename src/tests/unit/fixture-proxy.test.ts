import http from 'node:http';
import net from 'node:net';
import { expect, it } from 'vitest';
import { fixtureServer, forwardingProxy } from '../fixtures/server';

it('rejects external CONNECT requests, survives client resets and still forwards local HTTP', async () => {
  const proxy = await forwardingProxy(), site = await fixtureServer();
  try {
    for (let i = 0; i < 10; i++) {
      const rejected = await new Promise<string>((resolve, reject) => {
        const client = net.connect(proxy.port, '127.0.0.1', () => client.write('CONNECT external.invalid:443 HTTP/1.1\r\nHost: external.invalid:443\r\n\r\n'));
        client.on('error', reject);
        client.once('data', data => { const text = data.toString(); client.resetAndDestroy(); resolve(text); });
      });
      expect(rejected).toContain('502 Bad Gateway');
    }
    const received = await new Promise<{ status?: number; text: string }>((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: proxy.port, path: site.origin + '/' }, response => {
        let text = ''; response.on('data', chunk => text += String(chunk)); response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, text }));
      });
      request.on('error', reject);
    });
    expect(received.status).toBe(200); expect(received.text).toContain('Controlled search provider');
    expect(site.logs.some(log => log.path === '/')).toBe(true);
  } finally { await proxy.close(); await site.close(); }
});
