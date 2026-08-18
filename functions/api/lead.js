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

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }
  const domain = email.split('@')[1];
  if (FREE_INBOXES.has(domain)) {
    return json({ ok: false, error: 'free_inbox' }, 422);
  }

  const lead = {
    email,
    domain,
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

  // 2. webhook (Google Sheet / Zapier / Make / Slack)
  if (env.LEAD_WEBHOOK) {
    try {
      await fetch(env.LEAD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead)
      });
    } catch (e) { console.error('Webhook failed', e); }
  }

  // 3. always logged
  console.log('LEAD', JSON.stringify(lead));

  return json({ ok: true });
}

// anything other than POST
export const onRequest = () => json({ ok: false, error: 'method_not_allowed' }, 405);
