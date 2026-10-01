// Runs the Worker under Node with fake GitHub and Access, serving public/ as assets.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakes } from './fake-github.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

export async function startServer({ port = 8787, localEmail = 'tester@example.org' } = {}) {
  const fakes = makeFakes();
  globalThis.fetch = fakes.fakeFetch;
  const worker = (await import(`../worker/index.js?${Date.now()}`)).default;

  const env = {
    ROUND: 'alpha1',
    ROUND_VERSION: 'v0.6.0-alpha.1',
    GH_ORG: 'happenings-community',
    GH_APP_ID: '12345',
    GH_APP_PRIVATE_KEY: fakes.appPem,
    TRACKER_REPO: 'ro-test-tracker',
    REPORT_REPO: 'requests-and-offers',
    REPORT_CATEGORY: 'Release feedback',
    ACCESS_TEAM_DOMAIN: 'team.example.cloudflareaccess.com',
    ACCESS_AUD: 'aud-123',
    TESTER_ID_SECRET: 'local-secret',
    LOCAL_DEV_EMAIL: localEmail,
    ASSETS: {
      async fetch(req) {
        let p = new URL(req.url).pathname;
        if (p.endsWith('/')) p += 'index.html';
        const file = normalize(join(root, p));
        if (!file.startsWith(root)) return new Response('no', { status: 403 });
        try {
          return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
        } catch {
          return new Response(await readFile(join(root, '404.html')), { status: 404, headers: { 'content-type': TYPES['.html'] } });
        }
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, fakes, env, worker };
}
