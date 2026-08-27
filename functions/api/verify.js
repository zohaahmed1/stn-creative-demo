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

/**
 * SMTP-level mailbox check via MillionVerifier. MX only proves the domain
 * accepts mail; this proves the mailbox exists.
 *
 * NO-OP unless MILLIONVERIFIER_API_KEY is set, so behaviour is unchanged until
 * the key exists. Returns null on any failure — a verifier outage must never
 * cost a real lead.
 *
 * Blocks ONLY `invalid` and `disposable`. Deliberately allows `catch_all`:
 * most enterprise B2B domains are catch_all (mixpanel.com, stripe.com and
 * skipthenoisemedia.com itself all return it), so blocking it would reject
 * exactly the prospects this form exists to capture. That differs from our
 * COLD-OUTBOUND rule, where catch_all is dropped because a bounce costs
 * sender reputation. Inbound, a false rejection costs a lead — far worse.
 */
async function mailboxVerdict(env, email) {
  const key = env.MILLIONVERIFIER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=8`,
      { headers: { 'User-Agent': 'STNVerify/1.0' }, signal: AbortSignal.timeout(9000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.result === 'string' ? data.result : null;
  } catch (_) {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
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

  /* Also verify the address they will be contacted on. A form can pass every
     check above by pairing a real company website with a junk mailbox domain —
     "intellect-partners.com" plus "AESAE@SFSDF.COM" — because the freemail
     pattern only knows about Gmail and friends. sfsdf.com has no MX at all. */
  const email = String(body.email || '').trim().toLowerCase();
  if (email) {
    const at = email.split('@');
    if (at.length !== 2) return json({ ok: false, reason: 'bad_email' });
    const emailDomain = normaliseDomain(at[1]);
    if (!emailDomain)                     return json({ ok: false, reason: 'bad_email' });
    if (PLACEHOLDER.includes(emailDomain)) return json({ ok: false, reason: 'placeholder_email' });
    const emx = await hasMx(emailDomain);
    if (emx === false) return json({ ok: false, reason: 'email_domain_dead' });

    /* Only reached once DNS says the domain is real, so junk never costs a
       verification credit. */
    const verdict = await mailboxVerdict(env, email);
    if (verdict === 'invalid')    return json({ ok: false, reason: 'mailbox_invalid' });
    if (verdict === 'disposable') return json({ ok: false, reason: 'mailbox_disposable' });
  }

  // true or null (unknown) both pass
  return json({ ok: true, reason: mx ? 'mx' : 'unknown' });
}
