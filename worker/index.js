// The R&O test tracker: one Worker serving the page and its API from one hostname.
//
// Modelled on the design site (happenings-design-site). Static files come straight
// from assets; only /api/* runs this code (run_worker_first in wrangler.jsonc).
//
//   GET  /api/me           who you are this round, and your results so far
//   POST /api/register     your name and machine, once per round
//   PUT  /api/results      your Pass / Fail / Partial / Skip and notes
//   POST /api/screenshot   one image, stored in the tracker repo
//   POST /api/report       a Fail or Partial (or ad hoc) report, posted to a Discussion
//
// Three doors, each with one job:
//   Cloudflare Access   decides who can load anything at all (email one-time PIN)
//   this Worker         decides what a tester may write: only their own file, only
//                       images, only into the Release feedback category
//   the GitHub App      is the only credential, and reaches two repositories
//
// Same origin as the page, so no CORS, no preflight and no origin allowlist.

import { identify, testerId } from './access.js';
import {
  getJson, putFile, rawUrl, b64,
  findDiscussion, createDiscussion, commentOnDiscussion
} from './github.js';

// The same options as the Machine dropdown on the Release feedback form (#294), so a
// report reads the same whichever way it arrived.
export const MACHINES = [
  'Linux (.deb)',
  'Linux (AppImage)',
  'macOS, Apple Silicon (M1 or later)',
  'macOS, Intel',
  'Windows',
  'Other (say which below)'
];

const RESULTS = ['Pass', 'Fail', 'Partial', 'Skipped'];
const SEVERITIES = { minor: 'Minor', moderate: 'Moderate', major: 'Major', critical: 'Critical' };
const MAX_TEXT = 5000;
const MAX_IMAGE = 1.5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      return await api(request, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || 'server_error' }, 500);
    }
  }
};

async function api(request, env, url) {
  const email = await identify(request, env);
  if (!email) return json({ error: 'not_signed_in' }, 401);

  const id = await testerId(env, email);
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/me': return me(env, id);
    case 'POST /api/register': return register(request, env, id);
    case 'PUT /api/results': return saveResults(request, env, id);
    case 'POST /api/screenshot': return screenshot(request, env, id, url);
    case 'POST /api/report': return report(request, env, id, url);
    default: return json({ error: 'not_found' }, 404);
  }
}

// ── Paths and round ───────────────────────────────────────────────────────────

const testerPath = (env, id) => `data/rounds/${env.ROUND}/testers/${id}.json`;
const shotDir = (env, id) => `data/rounds/${env.ROUND}/screenshots/${id}/`;

function round(env) {
  return { id: env.ROUND, version: env.ROUND_VERSION, machines: MACHINES };
}

// Read from our own assets, not from the request: the step text in a report must be
// the text we published, not whatever a page sends.
let templateCache = null;
async function templates(env, url) {
  if (templateCache && templateCache.round === env.ROUND) return templateCache.steps;
  const res = await env.ASSETS.fetch(new Request(new URL(`/rounds/${env.ROUND}/templates.json`, url.origin)));
  if (!res.ok) throw new Error(`No templates for round ${env.ROUND}`);
  templateCache = { round: env.ROUND, steps: await res.json() };
  return templateCache.steps;
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function me(env, id) {
  const { json: tester } = await getJson(env, testerPath(env, id));
  return json({ round: round(env), tester });
}

async function register(request, env, id) {
  const body = await readJson(request);
  const name = clean(body.name, 60);
  const machine = MACHINES.includes(body.machine) ? body.machine : null;
  if (!name || !machine) return json({ error: 'Please give your name and choose your machine.' }, 400);

  const path = testerPath(env, id);
  const { json: existing, sha } = await getJson(env, path);

  const tester = {
    name,
    machine,
    os: clean(body.os, 80),
    network: clean(body.network, 500),
    registeredAt: existing?.registeredAt || new Date().toISOString().slice(0, 10),
    results: existing?.results || {}
  };

  await putFile(env, path, jsonB64(tester), `${env.ROUND}: ${existing ? 'update' : 'register'} ${name}`, sha);
  return json({ tester });
}

async function saveResults(request, env, id) {
  const body = await readJson(request);
  const path = testerPath(env, id);
  const { json: tester, sha } = await getJson(env, path);
  if (!tester) return json({ error: 'not_registered' }, 409);

  // The page sends what the tester controls; the Worker keeps what it owns (the
  // discussion link) so a page cannot overwrite it.
  const incoming = body.results || {};
  for (const [stepId, r] of Object.entries(incoming)) {
    if (!/^\d+\.\d+$/.test(stepId)) continue;
    const prev = tester.results[stepId] || {};
    tester.results[stepId] = {
      ...prev,
      result: RESULTS.includes(r.result) ? r.result : prev.result || null,
      notes: r.notes === undefined ? prev.notes || '' : clean(r.notes, MAX_TEXT)
    };
  }

  await putFile(env, path, jsonB64(tester), `${env.ROUND}: results for ${tester.name}`, sha);
  return json({ ok: true });
}

async function screenshot(request, env, id, url) {
  const step = url.searchParams.get('step');
  const label = step && /^\d+\.\d+$/.test(step) ? `step-${step}` : 'adhoc';

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return json({ error: 'empty' }, 400);
  if (bytes.length > MAX_IMAGE) return json({ error: 'Image too large after resizing.' }, 413);

  const ext = imageType(bytes);
  if (!ext) return json({ error: 'Only PNG, JPEG or WebP images.' }, 415);

  const path = `${shotDir(env, id)}${label}-${Date.now()}.${ext}`;
  await putFile(env, path, b64(bytes), `${env.ROUND}: screenshot ${label}`);
  return json({ url: rawUrl(env, path) });
}

async function report(request, env, id, url) {
  const body = await readJson(request);
  const path = testerPath(env, id);
  const { json: tester } = await getJson(env, path);
  if (!tester) return json({ error: 'not_registered' }, 409);

  const steps = await templates(env, url);
  const stepId = body.stepId == null ? null : String(body.stepId);
  const step = stepId ? steps.find((s) => String(s.stepId) === stepId) : null;
  if (stepId && !step) return json({ error: 'unknown_step' }, 400);

  const screen = clean(body.screen, 120);
  const happened = clean(body.whatHappened, MAX_TEXT);
  if (!screen || !happened) return json({ error: 'Please say which screen you were on and what happened.' }, 400);

  // Only images this tester uploaded through us, so a report cannot embed anything else.
  const prefix = rawUrl(env, shotDir(env, id));
  const shots = (Array.isArray(body.screenshots) ? body.screenshots : [])
    .filter((u) => typeof u === 'string' && u.startsWith(prefix) && /^[\w./:-]+$/.test(u))
    .slice(0, 6);

  const result = stepId ? tester.results[stepId]?.result || clean(body.result, 20) : null;
  const severity = SEVERITIES[body.severity] || SEVERITIES.moderate;
  const network = clean(body.network, 500) || tester.network || '';

  const text = renderReport(env, {
    tester, step, result, severity, screen, happened,
    did: clean(body.whatYouDid, MAX_TEXT),
    expected: clean(body.expected, MAX_TEXT),
    network, shots
  });

  let discussion, commentUrl = null;
  if (step) {
    // One thread per step per round. Later reports join it as comments, so the
    // maintainers weigh a step in one place before promoting it to an issue.
    const titlePrefix = `[${env.ROUND_VERSION}] ${step.stepId} `;
    discussion = await findDiscussion(env, titlePrefix);
    if (discussion) {
      commentUrl = (await commentOnDiscussion(env, discussion.id, text)).url;
    } else {
      discussion = await createDiscussion(env, `${titlePrefix}· ${step.testArea}`, text);
    }
  } else {
    const summary = clean(body.summary, 100);
    if (!summary) return json({ error: 'Please give a short summary.' }, 400);
    discussion = await createDiscussion(env, `[${env.ROUND_VERSION}] ${summary}`, text);
  }

  if (step) {
    // Re-read: the page may have saved a result or notes while GitHub was answering,
    // and writing back the copy from the start of this request would undo it.
    const { json: fresh, sha: freshSha } = await getJson(env, path);
    const latest = fresh || tester;
    latest.results[stepId] = { ...(latest.results[stepId] || {}), discussion: commentUrl || discussion.url };
    await putFile(env, path, jsonB64(latest), `${env.ROUND}: report link for ${latest.name}`, freshSha);
  }

  return json({ url: commentUrl || discussion.url, number: discussion.number, joined: Boolean(commentUrl) });
}

// ── The report itself ─────────────────────────────────────────────────────────

/**
 * Headings match the Release feedback form from #294: Version, Machine, Screen,
 * What you did, What happened and what you expected, Screenshots, Network details.
 * A tracker report and a hand-written one then read the same to whoever triages.
 */
export function renderReport(env, r) {
  const lines = [];
  const who = r.tester.name;
  lines.push(r.step
    ? `**Step ${r.step.stepId}, ${r.step.testArea}: ${r.result || 'reported'}** · Severity: ${r.severity}`
    : `**Ad hoc report** · Severity: ${r.severity}`);
  lines.push(`Reported by ${md(who)} through the R&O test tracker.`);
  lines.push('');
  lines.push('### Version', '', env.ROUND_VERSION, '');
  lines.push('### Machine', '', [r.tester.machine, r.tester.os].filter(Boolean).map(md).join(', '), '');
  lines.push('### Screen', '', md(r.screen), '');

  lines.push('### What you did', '');
  if (r.step) {
    lines.push('Followed the test step:', '');
    lines.push(...bullets(r.step.stepAction));
    lines.push('');
  }
  if (r.did) lines.push(quote(r.did), '');
  if (!r.step && !r.did) lines.push('_Not given_', '');

  lines.push('### What happened, and what you expected', '');
  lines.push(quote(r.happened), '');
  if (r.step) {
    lines.push('Expected, from the test step:', '');
    lines.push(...bullets(r.step.lookFor), '');
  } else if (r.expected) {
    lines.push('Expected:', '', quote(r.expected), '');
  }

  lines.push('### Screenshots', '');
  if (r.shots.length) r.shots.forEach((u, i) => lines.push(`![Screenshot ${i + 1}](${u})`));
  else lines.push('_None_');
  lines.push('');

  lines.push('### Network details', '');
  lines.push(r.network ? '```text\n' + r.network.replace(/```/g, "'''") + '\n```' : '_Not given_');
  return lines.join('\n');
}

function bullets(str) {
  const parts = String(str || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [md(parts[0] || '')];
  return [md(parts[0]), ...parts.slice(1).map((p) => `- ${md(p)}`)];
}

// Tester text is quoted, so it reads as theirs and cannot pose as a heading.
function quote(s) { return md(s).split('\n').map((l) => `> ${l}`).join('\n'); }

// Stop @mentions pinging people and stray HTML rendering.
function md(s) { return String(s).replace(/@/g, '@​').replace(/</g, '&lt;'); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
}

function imageType(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

function jsonB64(obj) { return b64(new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n')); }

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
