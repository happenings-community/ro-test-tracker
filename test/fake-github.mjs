// A stand-in for the parts of GitHub and Cloudflare Access the Worker talks to,
// so the whole flow can be exercised locally without touching real repositories.

import { generateKeyPairSync, createVerify, createSign, createHash } from 'node:crypto';

export function makeFakes() {
  // The App's key, exported as PKCS#1 exactly as GitHub hands it out.
  const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appPem = app.privateKey.export({ type: 'pkcs1', format: 'pem' });

  // Access's signing key, published as a JWK.
  const access = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const accessJwk = { ...access.publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256' };

  const files = new Map();          // path -> { content(base64), sha }
  const discussions = [];           // { id, number, title, url, body, comments: [] }
  const log = [];
  let installTokens = 0;

  const realFetch = globalThis.fetch;

  async function fakeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || '';

    if (url.hostname === 'team.example.cloudflareaccess.com') {
      return Response.json({ keys: [accessJwk] });
    }
    if (url.hostname !== 'api.github.com') return realFetch(input, init);

    log.push(`${method} ${url.pathname}`);

    // App JWT endpoints: verify the signature with the App's public key.
    if (url.pathname === '/orgs/happenings-community/installation' ||
        url.pathname.startsWith('/app/installations/')) {
      const jwt = auth.replace(/^Bearer /, '');
      const [h, p, s] = jwt.split('.');
      const v = createVerify('RSA-SHA256');
      v.update(`${h}.${p}`);
      const ok = v.verify(app.publicKey, Buffer.from(s, 'base64url'));
      const payload = JSON.parse(Buffer.from(p, 'base64url'));
      if (!ok || payload.iss !== '12345') return new Response('bad jwt', { status: 401 });
      if (url.pathname.startsWith('/orgs/')) return Response.json({ id: 99 });
      installTokens++;
      // Scoped tokens: the token says what it may touch, and the fake enforces it.
      const req = JSON.parse(init.body || '{}');
      const perms = Object.keys(req.permissions || {});
      const repos = req.repositories || [];
      if (perms.length !== 1 || repos.length !== 1) return new Response('unscoped token request', { status: 400 });
      return Response.json({ token: `ghs_${perms[0]}_${repos[0]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }

    const contents = url.pathname.match(/^\/repos\/happenings-community\/ro-test-tracker\/contents\/(.+)$/);
    if (contents) {
      if (auth !== 'Bearer ghs_contents_ro-test-tracker') return new Response('wrong token for files', { status: 403 });
      const path = decodeURIComponent(contents[1]);
      if (method === 'GET') {
        const f = files.get(path);
        return f ? Response.json({ content: f.content, sha: f.sha }) : new Response('{}', { status: 404 });
      }
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        const existing = files.get(path);
        if (existing && body.sha !== existing.sha) return new Response('{"message":"sha does not match"}', { status: 409 });
        if (!existing && body.sha) return new Response('{"message":"sha given for new file"}', { status: 422 });
        const sha = createHash('sha1').update(body.content).digest('hex');
        files.set(path, { content: body.content, sha, message: body.message });
        return Response.json({ content: { sha } });
      }
    }

    if (url.pathname === '/graphql') {
      if (auth !== 'Bearer ghs_discussions_requests-and-offers') return new Response('wrong token for discussions', { status: 403 });
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('discussionCategories')) {
        return Response.json({ data: { repository: { id: 'R_1', discussionCategories: { nodes: [
          { id: 'C_gen', name: 'General' }, { id: 'C_rf', name: 'Release feedback' }
        ] } } } });
      }
      if (query.includes('createDiscussion')) {
        if (variables.cat !== 'C_rf' || variables.repo !== 'R_1') return Response.json({ errors: [{ message: 'wrong target' }] });
        const n = 400 + discussions.length;
        const d = { id: `D_${n}`, number: n, title: variables.title, body: variables.body,
          url: `https://github.com/happenings-community/requests-and-offers/discussions/${n}`, comments: [] };
        discussions.push(d);
        return Response.json({ data: { createDiscussion: { discussion: { id: d.id, number: d.number, url: d.url } } } });
      }
      if (query.includes('addDiscussionComment')) {
        const d = discussions.find((x) => x.id === variables.id);
        d.comments.push(variables.body);
        return Response.json({ data: { addDiscussionComment: { comment: { url: `${d.url}#discussioncomment-${d.comments.length}` } } } });
      }
      if (query.includes('discussions(')) {
        const nodes = [...discussions].reverse().map(({ id, number, title, url }) => ({ id, number, title, url }));
        return Response.json({ data: { repository: { discussions: { nodes } } } });
      }
    }

    return new Response(`unhandled ${method} ${url.pathname}`, { status: 500 });
  }

  function accessJwt(email, aud = 'aud-123', overrides = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      email, aud: [aud], iss: 'https://team.example.cloudflareaccess.com',
      exp: Math.floor(Date.now() / 1000) + 3600, ...overrides
    })).toString('base64url');
    const s = createSign('RSA-SHA256');
    s.update(`${header}.${payload}`);
    return `${header}.${payload}.${s.sign(access.privateKey).toString('base64url')}`;
  }

  return { fakeFetch, appPem, files, discussions, log, accessJwt, installTokens: () => installTokens };
}
