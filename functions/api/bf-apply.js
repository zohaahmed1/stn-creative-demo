/* Black Friday application form -> partial + final capture.
 *
 * Cloudflare Pages Functions format. Same-origin POSTs from /black-friday-ads.
 * Kept separate from /api/lead on purpose: that endpoint carries the /quiz
 * qualification, SaaS domain checks and CAPI Lead logic, and it has regressed
 * twice. Nothing here can break the quiz.
 *
 * Three kinds of POST:
 *   - "partial":   sent (debounced) as the visitor answers. Stored only.
 *   - "abandoned": sent once, by sendBeacon, when the tab is hidden or closed
 *                  after they started but before they submitted.
 *   - "submit":    the finished application, sent right before Cal opens.
 *
 * Storage:
 *   1. KV (env.LEADS) if bound. Every kind, keyed bf:<sid>, latest snapshot wins.
 *      No quota. This is where partials live. Bind a KV namespace as LEADS in
 *      Cloudflare -> Pages -> Settings -> Functions -> KV bindings.
 *   2. Formspree (env.LEAD_WEBHOOK, default "Quiz Leads" xyeglebv). Free plan =
 *      50 submissions/month shared with the quiz, so only "submit" and one
 *      identifiable "abandoned" per visitor go there. Never "partial".
 *      Formshield must stay OFF on that form, or server POSTs land in spam.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const FIELDS = ['website', 'category', 'spend', 'channels', 'makers', 'timing', 'name', 'email'];
const clip = (v, n = 300) => String(v == null ? '' : v).slice(0, n).trim();

// Spend bands that can carry a $4,000/month creative package.
const QUALIFIED_SPEND = new Set(['5-20k', '20-50k', '50k+']);

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  if (origin && !origin.includes(url.host) && !origin.includes('localhost')) {
    return json({ ok: false, error: 'bad_origin' }, 403);
  }

  // sendBeacon posts can arrive as text/plain, so parse the raw text either way.
  let body;
  try { body = JSON.parse(await request.text()); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400); }

  if (body.company_url) return json({ ok: true }); // honeypot. Real field is `website`.

  const kind = ['partial', 'abandoned', 'submit'].includes(body.kind) ? body.kind : 'partial';
  const sid = clip(body.sid, 64).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sid) return json({ ok: false, error: 'no_sid' }, 400);

  const a = body.answers || {};
  const answers = {};
  for (const f of FIELDS) {
    const v = Array.isArray(a[f]) ? a[f].map((x) => clip(x, 40)).slice(0, 8).join(', ') : clip(a[f]);
    if (v) answers[f] = v;
  }
  if (answers.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.email)) delete answers.email;

  const record = {
    sid,
    kind,
    ts: new Date().toISOString(),
    step: clip(body.step, 20),
    answers,
    qualified: QUALIFIED_SPEND.has(answers.spend || ''),
    page: clip(body.page, 200),
    utm: clip(body.utm, 300),
    country: request.headers.get('CF-IPCountry') || '',
  };

  // 1. KV: every event, one record per visitor.
  let stored = false;
  if (env.LEADS) {
    try {
      await env.LEADS.put(`bf:${sid}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 });
      stored = true;
    } catch (e) { console.error('KV write failed', e); }
  }

  // 2. Formspree: finished applications, plus abandoned ones we can identify.
  const identifiable = Boolean(answers.email || answers.website);
  const notify = kind === 'submit' || (kind === 'abandoned' && identifiable);
  let notified = false;
  if (notify) {
    const webhook = env.LEAD_WEBHOOK || 'https://formspree.io/f/xyeglebv';
    const label = kind === 'submit' ? 'submitted' : 'started, not finished';
    const fit = record.qualified ? 'fits' : (answers.spend ? 'below budget' : 'budget unknown');
    try {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: `Black Friday application ${label} (${fit}): ${answers.website || answers.email || sid}`,
          source: 'black-friday-ads',
          status: kind === 'submit' ? 'submitted' : 'abandoned',
          last_step: record.step,
          ...answers,
          email: answers.email || '',
          utm: record.utm,
          country: record.country,
          sid,
        }),
      });
      notified = r.ok;
    } catch (e) { console.error('webhook failed', e); }
  }

  return json({ ok: true, kind, stored, notified, qualified: record.qualified });
}
