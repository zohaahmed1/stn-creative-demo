/* POST /api/playbook-lead: copy of a Reddit AMA playbook download.
 *
 * playbook.html still posts to Formspree ("Reddit Playbook - Apr 3", xwvwrbgj)
 * from the browser, which sends the email. Formspree's free plan only keeps 30
 * days, so once Formspree says OK the page also sends a beacon here, and this
 * keeps the lead for good:
 *   1. KV (env.LEADS), keyed pb:<time>:<email>, kept 2 years.
 *   2. The "STN Leads" Google Sheet (env.SHEET_WEBHOOK, lib/sheet.js).
 *
 * The page has already run /api/verify on the email and website, so this only
 * re-checks the shape of the email and drops honeypot hits.
 */

import { toSheet } from '../../lib/sheet.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n = 200) => String(v == null ? '' : v).slice(0, n).trim();

export async function onRequestPost({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  if (origin && !origin.includes(url.host) && !origin.includes('localhost')) {
    return json({ ok: false, error: 'bad_origin' }, 403);
  }

  // sendBeacon posts arrive as text/plain, so parse the raw text.
  let body;
  try { body = JSON.parse(await request.text()); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }
  if (body._gotcha) return json({ ok: true }); // honeypot

  const email = clip(body.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'bad_email' }, 400);

  const lead = {
    ts: new Date().toISOString(),
    name: [clip(body.first, 60), clip(body.last, 60)].filter(Boolean).join(' '),
    email,
    company: clip(body.company, 80),
    website: clip(body.website, 120),
    utm: clip(body.utm, 300),
    page: clip(body.page, 120),
    country: request.headers.get('CF-IPCountry') || '',
  };

  let stored = false;
  if (env.LEADS) {
    try { await env.LEADS.put(`pb:${lead.ts}:${email}`, JSON.stringify(lead), { expirationTtl: 60 * 60 * 24 * 730 }); stored = true; }
    catch (e) { console.error('KV write failed', e); }
  }

  const sheet = toSheet(env, {
    source: 'Reddit AMA', status: 'Downloaded playbook',
    name: lead.name, email, company: lead.company, website: lead.website,
    country: lead.country, utm: lead.utm, page: lead.page, id: lead.ts,
  });
  if (waitUntil) waitUntil(sheet); else await sheet;

  return json({ ok: true, stored });
}

export const onRequest = () => json({ ok: false, error: 'method_not_allowed' }, 405);
