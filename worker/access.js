// Who is asking. Cloudflare Access sits in front of this Worker and signs every
// request it lets through with a JWT in the Cf-Access-Jwt-Assertion header.
//
// We verify that JWT rather than trusting the plain email header beside it. With
// workers_dev and preview_urls off, Access is the only way in, so the header would
// probably be honest anyway; verifying makes "probably" unnecessary, and it fails
// closed if someone later adds a route Access does not cover.

let certs = { keys: null, fetched: 0 };

export async function identify(request, env) {
  const url = new URL(request.url);

  // Local development only: the harness runs on localhost with no Access in front.
  // Both conditions are required, so a stray variable in production does nothing.
  if (env.LOCAL_DEV_EMAIL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return env.LOCAL_DEV_EMAIL.toLowerCase();
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]));
    payload = JSON.parse(b64urlDecodeText(parts[1]));
  } catch {
    return null;
  }

  const key = await signingKey(env, header.kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.exp && payload.exp < now) return null;
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!payload.email) return null;

  return String(payload.email).toLowerCase();
}

async function signingKey(env, kid) {
  // Access rotates its keys every few weeks; an hour's cache is plenty.
  if (!certs.keys || Date.now() - certs.fetched > 60 * 60 * 1000 || !certs.keys.some((k) => k.kid === kid)) {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    certs = { keys: (await res.json()).keys || [], fetched: Date.now() };
  }
  const jwk = certs.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/**
 * A stable, opaque id for a tester. Results live in a public repo, so the email
 * never goes there: an HMAC keyed with a Worker secret gives the same id every
 * visit without being reversible by guessing addresses.
 *
 * Changing TESTER_ID_SECRET orphans every tester's file. Set it once.
 */
export async function testerId(env, email) {
  if (!env.TESTER_ID_SECRET) throw new Error('server_missing_tester_id_secret');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.TESTER_ID_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email)));
  return [...mac.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlDecode(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}
function b64urlDecodeText(s) { return new TextDecoder().decode(b64urlDecode(s)); }
