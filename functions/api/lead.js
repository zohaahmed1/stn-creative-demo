/**
 * POST /api/lead — quiz lead capture
 *
 * Deploys automatically with Cloudflare Pages (any file under /functions).
 * Same-origin, so no CORS dance and the browser gets real status codes.
 *
 * Sinks, in order of what's configured:
 *   1. LEADS        — KV namespace binding (Settings → Functions → KV bindings)
 *   2. LEAD_WEBHOOK — env var; forwards the lead as JSON (Sheets/Zapier/Make/Slack)
 *   3. console      — always; visible in Cloudflare real-time logs
 */

import { verifyDomain, normaliseDomain } from '../../lib/verify-domain.js';

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value).toLowerCase().trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Server-side Lead. Fires ONLY for a self-reported-qualified lead whose domain
 * also passes verification, so Meta never learns from someone who picked
 * "$10M to $50M" to unlock a free deliverable. On broad targeting this is the
 * difference between an optimisation signal and a self-reinforcing junk loop.
 */
async function sendLeadToMeta(env, { email, domain, arr, eventId, fbp, fbc, ip, ua, sourceUrl }) {
  const token = env.META_CONVERSION_TOKEN;
  if (!token) return { sent: false, reason: 'no_token' };
  const pixelId = env.META_PIXEL_ID || '1906222660310524';
  try {
    const user_data = {};
    if (email) {
      const em = await sha256(email);
      user_data.em = [em];
      user_data.external_id = [em];
    }
    // fbp/fbc are what carry attribution when there is no email yet.
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;
    if (!email && !fbp && !fbc) return { sent: false, reason: 'no_match_keys' };
    if (ip) user_data.client_ip_address = ip;
    if (ua) user_data.client_user_agent = ua;

    const res = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: 'website',
          event_source_url: sourceUrl || 'https://skipthenoisemedia.com/quiz',
          user_data,
          custom_data: { content_name: 'quiz_qualified', arr, domain },
        }],
        access_token: token,
      }),
    });
    const data = await res.json();
    return res.ok
      ? { sent: true, events_received: data?.events_received }
      : { sent: false, reason: data?.error?.message || 'meta_error' };
  } catch (err) {
    return { sent: false, reason: String(err) };
  }
}

const FREE_INBOXES = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','aol.com','icloud.com',
  'me.com','msn.com','proton.me','protonmail.com','gmx.com','mail.com','yandex.com',
  'ymail.com','rocketmail.com','inbox.com','zoho.com','tutanota.com','googlemail.com'
]);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost({ request, env }) {
  // only accept from our own site
  const origin = request.headers.get('Origin') || '';
  const host = new URL(request.url).host;
  if (origin && !origin.includes(host) && !origin.includes('localhost')) {
    return json({ ok: false, error: 'bad_origin' }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'bad_json' }, 400); }

  // honeypot — bots fill hidden fields, humans never see them
  if (body.company_website) return json({ ok: true });

  /* Two kinds of POST arrive here.
     - kind "complete": quiz finished. No email yet. Carries the typed site plus
       the _fbp/_fbc cookies, which is what lets the server-side Lead match an ad
       click without an email address.
     - kind "email": the capture box. Email required, and it must be a work address.
     Lead fires on "complete" only, so there is exactly one Lead per person and no
     dedup problem between the two paths. */
  const kind = String(body.kind || 'email');

  const email = String(body.email || '').trim().toLowerCase();
  let domain = '';
  if (kind === 'email' || email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ ok: false, error: 'invalid_email' }, 400);
    }
    domain = email.split('@')[1];
    if (FREE_INBOXES.has(domain)) {
      return json({ ok: false, error: 'free_inbox' }, 422);
    }
  }

  // Prefer the site they typed in the quiz; fall back to the email domain.
  // NB: the field is `site`, never `company_website` — that name is the honeypot
  // above and would silently drop every real lead.
  const typedDomain = normaliseDomain(body.site);
  const checkDomain = typedDomain || domain;

  const claimsQualified = String(body.status || '') === 'qualified';
  let verification = { verified: false, signals: null, reason: 'not_checked' };
  if (claimsQualified && kind === 'complete' && checkDomain) {
    verification = await verifyDomain(checkDomain);
  }

  const lead = {
    email,
    name:        String(body.name      || '').slice(0, 60),
    last_name:   String(body.last_name || '').slice(0, 60),
    company:     String(body.company   || '').slice(0, 80),
    update:      body.update === true,
    domain,
    site:        typedDomain,
    checked:     checkDomain,
    verified:    verification.verified,
    verify_why:  verification.reason,
    competitors: String(body.competitors || '').slice(0, 200),
    status:   String(body.status   || '').slice(0, 40),
    arr:      String(body.arr      || '').slice(0, 40),
    running:  String(body.running  || '').slice(0, 40),
    goal:     String(body.goal     || '').slice(0, 60),
    timing:   String(body.timing   || '').slice(0, 40),
    channels: String(body.channels || '').slice(0, 200),
    source:   String(body.source   || 'quiz').slice(0, 40),
    page:     String(body.page     || '').slice(0, 120),
    country:  request.headers.get('CF-IPCountry') || '',
    ts:       new Date().toISOString()
  };

  // 1. KV
  if (env.LEADS) {
    try { await env.LEADS.put(`lead:${lead.ts}:${email}`, JSON.stringify(lead)); }
    catch (e) { console.error('KV write failed', e); }
  }

  /* 2. webhook — this Formspree form is SHARED with the playbook download form in
        playbook.html. Two funnels at very different intent levels in one inbox.
        Set LEAD_WEBHOOK in Cloudflare (Settings → Environment variables) to a new
        Formspree form to split them properly; until then `Funnel` is the filter. */
  const webhook = env.LEAD_WEBHOOK || 'https://formspree.io/f/xwvwrbgj';
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: `${lead.update ? 'Quiz lead updated' : 'Quiz lead'} (${lead.status}) — ${lead.domain}`,
        Funnel:   'quiz',
        email:    lead.email,
        Name:     [lead.name, lead.last_name].filter(Boolean).join(' '),
        Company:  lead.company,
        Status:   lead.status,
        ARR:      lead.arr,
        Goal:     lead.goal,
        Timeline: lead.timing,
        Channels: lead.channels,
        'Running ads': lead.running,
        Country:  lead.country,
        Source:   lead.source,
        Page:     lead.page,
        Captured: lead.ts
      })
    });
  } catch (e) { console.error('Webhook failed', e); }

  // 4. Meta Lead — "complete" only, and only when the self-reported answers AND
  //    the domain check agree. Matched on _fbp/_fbc so it attributes to the ad
  //    click even though we have no email at this point.
  let meta = { sent: false, reason: kind === 'complete' ? 'not_qualified' : 'not_complete_event' };
  if (kind === 'complete' && claimsQualified && verification.verified) {
    meta = await sendLeadToMeta(env, {
      email,
      domain: checkDomain,
      arr: lead.arr,
      eventId: `quiz_${checkDomain}_${String(body.fbp || '').slice(-18) || lead.ts.slice(0, 10)}`.slice(0, 60),
      fbp: String(body.fbp || ''),
      fbc: String(body.fbc || ''),
      ip: request.headers.get('CF-Connecting-IP') || '',
      ua: request.headers.get('user-agent') || '',
      sourceUrl: lead.page ? `https://${host}${lead.page}` : '',
    });
  } else if (kind === 'complete' && claimsQualified) {
    meta = { sent: false, reason: `unverified:${verification.reason}` };
  }

  // 3. always logged
  console.log('LEAD', JSON.stringify({ ...lead, meta_lead: meta }));

  return json({ ok: true, verified: verification.verified, lead_sent: meta.sent });
}

// anything other than POST
export const onRequest = () => json({ ok: false, error: 'method_not_allowed' }, 405);
