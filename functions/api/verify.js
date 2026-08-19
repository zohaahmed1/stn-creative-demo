/**
 * Fast, blocking domain check for the quiz gate.
 *
 * The full SaaS verification in lib/verify-domain.js is too slow to sit in front
 * of a user — it can make three pricing-page fetches at 3.5s each. This route
 * runs only the MX lookup, which is a single DoH query and usually resolves in
 * well under a second. That is enough to kill the case the gate actually leaks:
 * a syntactically valid domain that does not exist ("acmeanalytics.com").
 *
 * The deeper SaaS check still runs server-side on the "complete" POST, and is
 * what gates the Meta Lead event. This is only the front door.
 *
 * Fails OPEN. If DNS is slow, or Cloudflare's resolver is down, or anything else
 * goes wrong, a real prospect must not be turned away — we return ok:true with a
 * reason of "unknown" and let the server-side check do its job later.
 */

import { normaliseDomain } from '../../lib/verify-domain.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const FREEMAIL = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'live.com', 'proton.me', 'protonmail.com', 'me.com', 'msn.com', 'gmx.com',
  'mail.com', 'yandex.com', 'zoho.com', 'googlemail.com'
];

const PLACEHOLDER = [
  'example.com', 'example.org', 'test.com', 'domain.com', 'yourcompany.com',
  'company.com', 'website.com', 'mysite.com', 'localhost', 'asdf.com', 'abc.com'
];

async function hasMx(domain) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(2500) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.Answer) && data.Answer.length > 0;
  } catch (_) {
    return null; // unknown, never a fail
  }
}

export async function onRequestPost({ request }) {
  const origin = request.headers.get('Origin') || '';
  const host = new URL(request.url).host;
  if (origin && !origin.includes(host) && !origin.includes('localhost')) {
    return json({ ok: false, reason: 'bad_origin' }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: true, reason: 'unknown' }); }

  const domain = normaliseDomain(body.site);
  if (!domain)                             return json({ ok: false, reason: 'malformed' });
  if (FREEMAIL.includes(domain))           return json({ ok: false, reason: 'freemail' });
  if (PLACEHOLDER.includes(domain))        return json({ ok: false, reason: 'placeholder' });

  const mx = await hasMx(domain);
  if (mx === false) return json({ ok: false, reason: 'no_such_domain' });

  // true or null (unknown) both pass
  return json({ ok: true, reason: mx ? 'mx' : 'unknown' });
}
