import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FixtureLog { path: string; cookie: string; body?: Record<string, unknown>; }
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export async function fixtureServer() {
  const logs: FixtureLog[] = [];
  const sockets = new Set<net.Socket>();
  let origin = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const log: FixtureLog = { path: url.pathname + url.search, cookie: request.headers.cookie ?? '' };
    logs.push(log);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/slow') return;
    if (url.pathname === '/probe' || url.pathname === '/scroll' || url.pathname === '/clicked') {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => { try { log.body = JSON.parse(body); } catch {} response.end('ok'); });
      return;
    }
    if (url.pathname === '/redirect-escape') { response.writeHead(302, { Location: 'http://outside.invalid/escape' }); response.end(); return; }
    if (url.pathname === '/article/redirect') { response.writeHead(302, { Location: 'http://outside.invalid/escape' }); response.end(); return; }
    if (url.pathname === '/redirect-results') { response.end('<main data-serp-results><section data-organic-result><a href="/article/redirect"><h3>Redirecting target article</h3></a></section></main>'); return; }
    if (url.pathname === '/hidden-layout') { response.end('<main id="search"><div style="display:none"><a href="/article/hidden"><h3>Hidden target</h3></a></div><div class="uEierd"><a href="/ad"><h3>Sponsored target</h3></a></div><div><a href="https://outside.test/first"><h3>Unrelated visible result</h3></a></div><div><a href="/article/one"><h3>Visible target article</h3></a></div></main>'); return; }
    if (url.pathname === '/challenge' || url.pathname === '/article/challenge') { response.end('<main>Our systems have detected unusual traffic from your computer network</main>'); return; }
    if (url.pathname === '/captcha') { response.end('<main>Verify you are human<div id="captcha">Human verification</div></main>'); return; }
    if (url.pathname === '/denied') { response.statusCode = 403; response.end('<main>Access denied</main>'); return; }
    if (url.pathname === '/unsupported') { response.end('<main>A surprising unsupported search layout</main>'); return; }
    if (url.pathname === '/article/one' || url.pathname === '/article/two' || url.pathname === '/article/three') {
      const next = url.pathname === '/article/one' ? '/article/two' : '/article/three';
      response.end(`<!doctype html><html><body><article style="height:2600px"><h1>Controlled article ${escape(url.pathname)}</h1><p>This fixture checks real scroll and internal navigation.</p><a href="/login">Log in</a><a href="/checkout">Checkout</a><a href="/article/download.pdf">Download</a><a href="/article/remove?token=private">Delete</a><a href="http://outside.invalid/article">External article</a><a href="${next}">Next safe article</a></article><script>let last=-1; window.addEventListener('scroll',()=>{if(Math.abs(scrollY-last)>100){last=scrollY; fetch('/scroll',{method:'POST',body:JSON.stringify({path:location.pathname,y:scrollY})})}})</script></body></html>`);
      return;
    }
    if (url.pathname === '/search' || url.pathname === '/dynamic' || url.pathname === '/google-layout') {
      const keyword = url.searchParams.get('q') ?? '';
      const page = Number(url.searchParams.get('page') ?? 1);
      const results = page === 1
        ? '<section data-organic-result data-sponsored><a href="/ad"><h3>Sponsored target</h3></a></section><section data-organic-result><a href="https://outside.test/first"><h3>Unrelated first</h3></a></section><section data-organic-result><a href="/article/one"><h3>Target first article</h3></a></section><section data-organic-result><a href="https://outside.test/third"><h3>Unrelated third</h3></a></section>'
        : '<section data-organic-result><a href="https://outside.test/fourth"><h3>Unrelated fourth</h3></a></section><section data-organic-result><a href="/article/two"><h3>Target second article</h3></a></section>';
      const next = page === 1 ? `<a ${url.pathname === '/google-layout' ? 'id="pnnext"' : 'data-next-page'} href="${url.pathname === '/google-layout' ? '/google-layout' : '/search'}?q=${encodeURIComponent(keyword)}&page=2">Next page</a>` : '';
      const googleResults = (results + next).replaceAll(' data-organic-result', '').replaceAll(' data-sponsored', ' class="uEierd"');
      const render = url.pathname === '/dynamic' ? `<div data-serp-results></div><script>setTimeout(()=>{document.querySelector('[data-serp-results]').innerHTML=${JSON.stringify(results + next)}},150)</script>` : url.pathname === '/google-layout' ? `<div id="${page === 1 ? 'search' : 'rso'}"></div><script>setTimeout(()=>{document.getElementById('${page === 1 ? 'search' : 'rso'}').innerHTML=${JSON.stringify(googleResults)}},150)</script>` : `<main data-serp-results>${results}${next}</main>`;
      response.end(`<!doctype html><html><body><h1>Results for ${escape(keyword)}</h1>${render}<script>const keyword=${JSON.stringify(keyword)}; const previous={cookie:document.cookie,local:localStorage.getItem('identity'),session:sessionStorage.getItem('identity')}; document.cookie='identity='+encodeURIComponent(keyword)+'; SameSite=Lax; path=/';localStorage.setItem('identity',keyword);sessionStorage.setItem('identity',keyword);fetch('/probe',{method:'POST',body:JSON.stringify({keyword,previous,local:localStorage.getItem('identity'),session:sessionStorage.getItem('identity'),cookie:document.cookie})});document.addEventListener('click',event=>{const anchor=event.target.closest('a');if(anchor && new URL(anchor.href).pathname.startsWith('/article/'))navigator.sendBeacon('/clicked',JSON.stringify({href:anchor.href,trusted:event.isTrusted}))})</script></body></html>`);
      return;
    }
    const action = url.searchParams.get('action') ?? '/search';
    response.end(`<!doctype html><html><body><h1>Controlled search provider</h1><form action="${escape(action)}"><input name="q" aria-label="Search"><button>Search</button></form></body></html>`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, logs, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export async function forwardingProxy() {
  const requests: string[] = [];
  const connects: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!);
    requests.push(url.href);
    const upstream = http.request(url, { method: request.method, headers: { ...request.headers, host: url.host } }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on('connect', (request, client, head) => {
    connects.push(request.url!);
    const target = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(target.port || 443), target.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server: `http://127.0.0.1:${port}`, port, requests, connects, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** A real SOCKS4 CONNECT endpoint for Chromium protocol regression checks. */
export async function socks4Proxy() {
  const sockets = new Set<net.Socket>();
  const targets: string[] = [];
  const server = net.createServer(client => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const handshake = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 9) return;
      const end = buffer.indexOf(0, 8); if (end < 0) return;
      client.removeListener('data', handshake);
      if (buffer[0] !== 4 || buffer[1] !== 1) { client.destroy(); return; }
      const host = [...buffer.subarray(4, 8)].join('.'), port = buffer.readUInt16BE(2);
      targets.push(`${host}:${port}`);
      const remaining = buffer.subarray(end + 1);
      const upstream = net.connect(port, host, () => {
        client.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
        if (remaining.length) upstream.write(remaining);
        client.pipe(upstream); upstream.pipe(client);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', handshake);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server: `socks4://127.0.0.1:${port}`, targets, close: async () => {
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
