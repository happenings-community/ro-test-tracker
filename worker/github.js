// Everything the tracker says to GitHub, as an org-owned GitHub App.
//
// The App is installed on two repositories and can do nothing else:
//   ro-test-tracker       Contents: read and write   (results and screenshots)
//   requests-and-offers   Discussions: read and write (reports)
//
// Reports appear as the App's bot account, never as a person, and nothing here
// expires the way a personal access token does: each request mints a fresh
// installation token (valid one hour) from the App's private key.

const API = 'https://api.github.com';
const UA = 'happenings-test-tracker';

// ── App authentication ────────────────────────────────────────────────────────

// An App's permissions apply to every repository it is installed on, so on its own
// it could write files to R&O too. Each token is therefore minted narrower than the
// App: one that can only write files in the tracker repo, one that can only write
// discussions on R&O. A bug here cannot reach further than the token it holds.
const SCOPES = {
  files: (env) => ({ repositories: [env.TRACKER_REPO], permissions: { contents: 'write' } }),
  discussions: (env) => ({ repositories: [env.REPORT_REPO], permissions: { discussions: 'write' } })
};

// Module scope survives between requests on the same isolate, so most requests
// reuse a token rather than minting one. Losing the cache only costs a round trip.
const cached = {};
let installationId = null;

export async function installationToken(env, scope) {
  const hit = cached[scope];
  if (hit && Date.now() < hit.expires - 5 * 60 * 1000) return hit.token;

  const jwt = await appJwt(env);
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: 'application/vnd.github+json',
    'user-agent': UA
  };

  if (!installationId) {
    const inst = await fetch(`${API}/orgs/${env.GH_ORG}/installation`, { headers });
    if (!inst.ok) throw new Error(`App is not installed on ${env.GH_ORG} (${inst.status})`);
    installationId = (await inst.json()).id;
  }

  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(SCOPES[scope](env))
  });
  if (!res.ok) throw new Error(`Could not mint a ${scope} token (${res.status})`);
  const data = await res.json();

  cached[scope] = { token: data.token, expires: Date.parse(data.expires_at) };
  return data.token;
}

async function appJwt(env) {
  if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY) throw new Error('server_missing_app_credentials');
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  // iat is back-dated a minute to allow for clock drift, as GitHub recommends.
  const payload = b64urlJson({ iat: now - 60, exp: now + 9 * 60, iss: String(env.GH_APP_ID) });
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.GH_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

/**
 * GitHub hands out keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), and WebCrypto only
 * imports PKCS#8. Rather than ask for an openssl conversion step, wrap the PKCS#1
 * bytes in the PKCS#8 envelope here. A key already in PKCS#8 passes straight through.
 */
export function pemToPkcs8(pem) {
  const isPkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der.buffer;

  // AlgorithmIdentifier for rsaEncryption with NULL parameters.
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(der.length), ...der];
  const body = [...version, ...algId, ...octet];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]).buffer;
}

function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

// ── REST and GraphQL ──────────────────────────────────────────────────────────

export async function rest(env, path, init = {}, scope = 'files') {
  const token = await installationToken(env, scope);
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
}

export async function graphql(env, query, variables) {
  const res = await rest(env, '/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables })
  }, 'discussions');
  const data = await res.json();
  if (!res.ok || data.errors) {
    const msg = data.errors ? data.errors.map((e) => e.message).join('; ') : res.status;
    throw new Error(`GitHub GraphQL: ${msg}`);
  }
  return data.data;
}

// ── Files in the tracker repo ─────────────────────────────────────────────────

export async function getJson(env, path) {
  const res = await rest(env, `/repos/${env.GH_ORG}/${env.TRACKER_REPO}/contents/${path}`);
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`Could not read ${path} (${res.status})`);
  const data = await res.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  return { json: JSON.parse(text), sha: data.sha };
}

/** Write a file. One retry on a stale sha: the tester's own file, so last write wins. */
export async function putFile(env, path, base64, message, sha) {
  const url = `/repos/${env.GH_ORG}/${env.TRACKER_REPO}/contents/${path}`;
  const attempt = (s) => rest(env, url, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, ...(s ? { sha: s } : {}) })
  });

  let res = await attempt(sha);
  if (res.status === 409 || res.status === 422) {
    const current = await rest(env, url);
    const fresh = current.ok ? (await current.json()).sha : undefined;
    res = await attempt(fresh);
  }
  if (!res.ok) throw new Error(`Could not save ${path} (${res.status})`);
  return res.json();
}

export function rawUrl(env, path) {
  return `https://raw.githubusercontent.com/${env.GH_ORG}/${env.TRACKER_REPO}/main/${path}`;
}

// ── Discussions on R&O ────────────────────────────────────────────────────────

let ids = null; // { repositoryId, categoryId }

async function discussionIds(env) {
  if (ids) return ids;
  const data = await graphql(env, `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        discussionCategories(first: 50) { nodes { id name } }
      }
    }`, { owner: env.GH_ORG, name: env.REPORT_REPO });
  const cat = data.repository.discussionCategories.nodes.find((c) => c.name === env.REPORT_CATEGORY);
  if (!cat) throw new Error(`No discussion category called "${env.REPORT_CATEGORY}" on ${env.REPORT_REPO}`);
  ids = { repositoryId: data.repository.id, categoryId: cat.id };
  return ids;
}

/**
 * Find a discussion in the category whose title starts with `prefix`.
 * Reads the category's newest 100 directly rather than using search: search is
 * indexed with a delay, so a thread created a minute ago could be missed and a
 * second tester would start a duplicate.
 */
export async function findDiscussion(env, prefix) {
  const { categoryId } = await discussionIds(env);
  const data = await graphql(env, `
    query($owner: String!, $name: String!, $cat: ID!) {
      repository(owner: $owner, name: $name) {
        discussions(first: 100, categoryId: $cat, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { id number title url }
        }
      }
    }`, { owner: env.GH_ORG, name: env.REPORT_REPO, cat: categoryId });
  return data.repository.discussions.nodes.find((d) => d.title.startsWith(prefix)) || null;
}

export async function createDiscussion(env, title, body) {
  const { repositoryId, categoryId } = await discussionIds(env);
  const data = await graphql(env, `
    mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) {
      createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) {
        discussion { id number url }
      }
    }`, { repo: repositoryId, cat: categoryId, title, body });
  return data.createDiscussion.discussion;
}

export async function commentOnDiscussion(env, discussionId, body) {
  const data = await graphql(env, `
    mutation($id: ID!, $body: String!) {
      addDiscussionComment(input: { discussionId: $id, body: $body }) { comment { url } }
    }`, { id: discussionId, body });
  return data.addDiscussionComment.comment;
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

const enc = (s) => new TextEncoder().encode(s);
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlJson(obj) { return b64url(enc(JSON.stringify(obj))); }
