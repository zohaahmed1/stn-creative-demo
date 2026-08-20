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

const SITE = 'https://skipthenoisemedia.com';
const TRACK = '?utm_source=quiz-email';
const BENCHMARKS = `${SITE}/blog/reddit-ads-benchmarks${TRACK}`;
const CAL = `https://cal.com/skipthenoise/30min${TRACK}`;

const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * Confirmation email to the lead. Without this they get a green line on the page
 * and then five days of silence, which is the one path in the funnel where nobody
 * hears from us — the booking path at least gets a Cal invite.
 *
 * NO-OP unless RESEND_API_KEY is set, so behaviour is unchanged until the key
 * exists. Never throws and never blocks the lead from being recorded: a failed
 * confirmation must not lose the lead itself.
 *
 * Skipped on `update` re-saves (someone typing their name after the email blur
 * already fired) so nobody gets the same email twice.
 */
async function sendConfirmation(env, lead) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'no_api_key' };
  if (lead.update)         return { sent: false, reason: 'update_resave' };
  if (!lead.email)         return { sent: false, reason: 'no_email' };

  // lead.name is whatever they typed, and it lands in an HTML body — escape it
  const first = String(lead.name || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${esc(first)},` : 'Hi,';
  const qualified = lead.status === 'qualified';

  const subject = qualified
    ? 'Your threads and three ads, in progress'
    : 'Your 2026 Reddit ad benchmarks';

  const paras = qualified ? [
    hi,
    'Got your details. We are pulling the threads where your category is being compared, and writing three Reddit ads off the back of what we find.',
    'You will have all of it within five business days.',
    `In the meantime, here are our 2026 Reddit ad benchmarks. Real numbers from campaigns we run, not vendor averages.<br><a href="${BENCHMARKS}">See the benchmarks</a>`,
    `If you would rather walk through the threads live when they are ready, grab 30 minutes here.<br><a href="${CAL}">Book 30 minutes</a>`,
    'Zoha<br><span style="color:#6b7280;">Skip the Noise Media</span>'
  ] : [
    hi,
    `Here are our 2026 Reddit ad benchmarks. Real numbers from campaigns we run, not vendor averages.<br><a href="${BENCHMARKS}">See the benchmarks</a>`,
    'Genuinely useful whether or not you ever work with us.',
    'Zoha<br><span style="color:#6b7280;">Skip the Noise Media</span>'
  ];

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0d0d0d;max-width:520px;">' +
    paras.map((p) => `<p style="margin:0 0 16px;">${p}</p>`).join('') +
    '</div>';

  /* Turn every anchor into "label: url" so the plain-text part keeps its links.
     The previous version string-replaced the two qualified link labels, which
     silently dropped the URL from the non-qualified copy entirely. */
  const text = paras
    .map((p) => p
      .replace(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g, (_, url, label) => `${label}: ${url}`)
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    .join('\n\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.LEAD_FROM || 'Zoha <zoha@skipthenoisemedia.com>',
        reply_to: env.LEAD_REPLY_TO || 'zoha@skipthenoisemedia.com',
        to: [lead.email],
        subject,
        html,
        text
      }),
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) {
      console.error('Confirmation failed', res.status, await res.text());
      return { sent: false, reason: `resend_${res.status}` };
    }
    return { sent: true, qualified };
  } catch (e) {
    console.error('Confirmation threw', e);
    return { sent: false, reason: 'exception' };
  }
}

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
  let stored = false;
  if (env.LEADS) {
    try {
      await env.LEADS.put(`lead:${lead.ts}:${email}`, JSON.stringify(lead));
      stored = true;
    } catch (e) { console.error('KV write failed', e); }
  }

  /* 2. webhook — "Quiz Leads" (xyeglebv). Separate from the playbook download form
        (xwvwrbgj, "Reddit Playbook - Apr 3") which playbook.html still posts to.
        These are different funnels at very different intent levels, so they get
        different inboxes. Override with LEAD_WEBHOOK if that ever needs to move. */
  const webhook = env.LEAD_WEBHOOK || 'https://formspree.io/f/xyeglebv';

  /* The inbox is for people who can be contacted. A "complete" event carries no
     email — it fires when someone finishes the quiz, whether or not they ever
     leave one — so it is noise in an inbox while still being needed for the Meta
     Lead event. Those rows were every one of the 12 that landed in spam.

     Skipped unconditionally. This was previously gated on KV being bound so the
     record survived somewhere, but no KV namespace is actually bound on this
     project, so the guard never fired and every completion emailed. Contactless
     rows still hit console.log and still fire the Meta Lead. If durable storage
     is wanted, bind a LEADS KV namespace rather than re-enabling these emails. */
  /* Notifications fire for contactable leads only. A "complete" carries no email
     — it exists to trigger the verified Meta/LinkedIn conversion — so it never
     emails, regardless of KV. That plus the once-per-load guard in quiz.html is
     what stops the duplicate-submission problem at both ends. */
  /* Formspree free is 50 submissions a month, so every send has to earn its place.
     What gets through:
       - anything carrying an email: contactable, already past the free-inbox
         filter, always worth a notification
       - a contactless "complete" ONLY if the domain passed verification. The
         company is identifiable from the site they typed even without an email,
         so it is a real notification — but a junk or test submission types a
         domain that fails MX and the SaaS signal checks, and those must not eat
         the quota.
     What is skipped:
       - `update` re-saves: the first send already carried the email, domain and
         every quiz answer, so a second one just to add a name doubled the burn
         rate for no follow-up value. */
  const contactless = !lead.email;
  const unverifiedComplete = contactless && !verification.verified;
  /* The client decides WHICH of its posts carries the notification, so one person
     produces one email instead of two. The completion post sets notify:false — it
     exists to fire the Meta/LinkedIn conversions — and the notification is sent
     either by the email capture (richer, has contact details) or by a sendBeacon
     when the visitor leaves without one. Absent flag means notify, so any other
     caller behaves as before. */
  const wantsNotify = body.notify !== false;
  const skipWebhook = !wantsNotify || unverifiedComplete || lead.update;

  if (skipWebhook) {
    console.log('Webhook skipped', !wantsNotify ? 'notify:false (client defers)' : lead.update ? 'update re-save' : 'unverified complete (' + verification.reason + ')', lead.checked);
  } else try {
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

  // 3. confirmation email to the lead — see sendConfirmation for the no-op contract
  const confirm = await sendConfirmation(env, lead);

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

  // 5. always logged
  console.log('LEAD', JSON.stringify({ ...lead, meta_lead: meta }));

  /* `stored` and `emailed` are diagnostics — they are the only way to tell from
     outside whether the KV namespace is bound and whether RESEND_API_KEY is set,
     without opening the Cloudflare dashboard. No lead data is echoed back. */
  return json({
    ok: true,
    verified: verification.verified,
    lead_sent: meta.sent,
    stored,
    emailed: confirm.sent,
    email_why: confirm.reason || null
  });
}

// anything other than POST
export const onRequest = () => json({ ok: false, error: 'method_not_allowed' }, 405);
