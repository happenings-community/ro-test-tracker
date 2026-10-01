// node --test test/api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const { server, fakes, env, worker } = await startServer({ port: 8788 });
const HOST = 'https://test.happenings.community';

function call(method, path, { email = 'anna@example.org', jwt, body, type } = {}) {
  const headers = {};
  const token = jwt !== undefined ? jwt : email ? fakes.accessJwt(email) : null;
  if (token) headers['cf-access-jwt-assertion'] = token;
  if (body !== undefined) headers['content-type'] = type || 'application/json';
  return worker.fetch(new Request(HOST + path, {
    method, headers, body: body === undefined ? undefined : (type ? body : JSON.stringify(body))
  }), env);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('Access: refuses requests without a valid Access token', async () => {
  assert.equal((await call('GET', '/api/me', { email: null })).status, 401);
  assert.equal((await call('GET', '/api/me', { jwt: fakes.accessJwt('a@x.org', 'other-aud') })).status, 401);
  assert.equal((await call('GET', '/api/me', { jwt: fakes.accessJwt('a@x.org', 'aud-123', { exp: 1 }) })).status, 401);
  assert.equal((await call('GET', '/api/me', { jwt: fakes.accessJwt('a@x.org', 'aud-123', { iss: 'https://evil.example' }) })).status, 401);
  const good = fakes.accessJwt('a@x.org').split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'boss@x.org', aud: ['aud-123'], iss: 'https://team.example.cloudflareaccess.com', exp: 9e9 })).toString('base64url');
  assert.equal((await call('GET', '/api/me', { jwt: `${good[0]}.${forged}.${good[2]}` })).status, 401);
});

test('Access: the local-dev shortcut does nothing off localhost', async () => {
  // env.LOCAL_DEV_EMAIL is set in this harness, yet a real hostname still needs a token.
  assert.equal((await call('GET', '/api/me', { email: null })).status, 401);
});

test('static files are served without running the API', async () => {
  const res = await worker.fetch(new Request(HOST + '/rounds/alpha1/templates.json'), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).length, 50);
});

test('register: validates, stores no email, one file per tester', async () => {
  const me = await (await call('GET', '/api/me')).json();
  assert.equal(me.tester, null);
  assert.equal(me.round.version, 'v0.6.0-alpha.1');

  assert.equal((await call('POST', '/api/register', { body: { name: 'Anna', machine: 'A toaster' } })).status, 400);
  const res = await call('POST', '/api/register', { body: { name: 'Anna', machine: 'macOS, Intel', os: 'macOS 15', network: 'seed abc' } });
  assert.equal(res.status, 200);

  const paths = [...fakes.files.keys()];
  assert.equal(paths.length, 1);
  assert.match(paths[0], /^data\/rounds\/alpha1\/testers\/[0-9a-f]{16}\.json$/);
  const stored = Buffer.from(fakes.files.get(paths[0]).content, 'base64').toString();
  assert.ok(!stored.includes('example.org'), 'email must not reach the public repo');
  assert.equal(JSON.parse(stored).machine, 'macOS, Intel');
});

test('results: saves the tester\'s fields only', async () => {
  const res = await call('PUT', '/api/results', { body: { results: {
    '13.2': { result: 'Fail', notes: 'Button did nothing' },
    '../../index': { result: 'Pass' },
    '14.1': { result: 'Hacked', notes: 'x', discussion: 'https://evil.example' }
  } } });
  assert.equal(res.status, 200);
  const me = await (await call('GET', '/api/me')).json();
  assert.equal(me.tester.results['13.2'].result, 'Fail');
  assert.equal(me.tester.results['14.1'].result, null);
  assert.equal(me.tester.results['14.1'].discussion, undefined);
  assert.equal(me.tester.results['../../index'], undefined);
});

test('unregistered testers cannot save or report', async () => {
  assert.equal((await call('PUT', '/api/results', { email: 'new@x.org', body: { results: {} } })).status, 409);
  assert.equal((await call('POST', '/api/report', { email: 'new@x.org', body: { stepId: '13.2', screen: 's', whatHappened: 'h' } })).status, 409);
});

test('screenshots: images only, into the tester\'s own folder', async () => {
  const bad = await call('POST', '/api/screenshot?step=13.2', { body: new TextEncoder().encode('<html>'), type: 'image/png' });
  assert.equal(bad.status, 415);
  const big = await call('POST', '/api/screenshot', { body: new Uint8Array(2 * 1024 * 1024).fill(0xff), type: 'image/jpeg' });
  assert.equal(big.status, 413);
  const ok = await call('POST', '/api/screenshot?step=13.2', { body: PNG, type: 'image/png' });
  assert.equal(ok.status, 200);
  const { url } = await ok.json();
  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/happenings-community\/ro-test-tracker\/main\/data\/rounds\/alpha1\/screenshots\/[0-9a-f]{16}\/step-13\.2-\d+\.png$/);
  globalThis.lastShot = url;
});

test('report: first one starts a discussion in Release feedback, shaped like the #294 form', async () => {
  const res = await call('POST', '/api/report', { body: {
    stepId: '13.2', screen: 'Admin Dashboard', whatHappened: 'Nothing happened @Soushi888',
    whatYouDid: 'Pressed Return', severity: 'major',
    screenshots: [globalThis.lastShot, 'https://evil.example/x.png']
  } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.joined, false);

  assert.equal(fakes.discussions.length, 1);
  const d = fakes.discussions[0];
  assert.match(d.title, /^\[v0\.6\.0-alpha\.1\] 13\.2 · /);
  for (const h of ['### Version', '### Machine', '### Screen', '### What you did', '### What happened, and what you expected', '### Screenshots', '### Network details']) {
    assert.ok(d.body.includes(h), `missing ${h}`);
  }
  assert.ok(d.body.includes('macOS, Intel, macOS 15'));
  assert.ok(d.body.includes('seed abc'), 'registered network details are used when none given');
  assert.ok(d.body.includes(globalThis.lastShot));
  assert.ok(!d.body.includes('evil.example'), 'only the tester\'s own uploads may be embedded');
  assert.ok(!d.body.includes('@Soushi888'), '@mentions are neutralised');
  assert.ok(d.body.includes('Fail'));

  const me = await (await call('GET', '/api/me')).json();
  assert.equal(me.tester.results['13.2'].discussion, d.url);
  assert.equal(me.tester.results['13.2'].notes, 'Button did nothing', 'report must not clobber notes');
});

test('report: a second tester on the same step joins the thread', async () => {
  await call('POST', '/api/register', { email: 'ben@example.org', body: { name: 'Ben', machine: 'Windows' } });
  const res = await call('POST', '/api/report', { email: 'ben@example.org', body: { stepId: '13.2', result: 'Partial', screen: 'Admin', whatHappened: 'Same here' } });
  const data = await res.json();
  assert.equal(data.joined, true);
  assert.equal(fakes.discussions.length, 1);
  assert.equal(fakes.discussions[0].comments.length, 1);
  assert.ok(fakes.discussions[0].comments[0].includes('Reported by Ben'));
});

test('report: ad hoc reports need a summary and start their own thread', async () => {
  assert.equal((await call('POST', '/api/report', { body: { stepId: null, screen: 'x', whatHappened: 'y' } })).status, 400);
  const res = await call('POST', '/api/report', { body: { stepId: null, summary: 'Links field keeps a deleted website', screen: 'Create a request', whatHappened: 'It stayed', expected: 'It goes' } });
  assert.equal(res.status, 200);
  assert.equal(fakes.discussions.length, 2);
  assert.equal(fakes.discussions[1].title, '[v0.6.0-alpha.1] Links field keeps a deleted website');
});

test('report: unknown steps and missing fields are refused', async () => {
  assert.equal((await call('POST', '/api/report', { body: { stepId: '99.9', screen: 'x', whatHappened: 'y' } })).status, 400);
  assert.equal((await call('POST', '/api/report', { body: { stepId: '13.2', screen: '', whatHappened: 'y' } })).status, 400);
});

test('GitHub App: key converted from PKCS#1, JWT accepted, one scoped token per job, reused', async () => {
  assert.equal(fakes.installTokens(), 2);
});

test('unknown API routes 404', async () => {
  assert.equal((await call('DELETE', '/api/results')).status, 404);
  server.close();
});
