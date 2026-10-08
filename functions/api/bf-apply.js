/* Black Friday application form -> lead capture.
 *
 * Cloudflare Pages Functions format. Same-origin POSTs from /black-friday-ads.
 * Kept separate from /api/lead on purpose: that endpoint carries the /quiz
 * qualification, SaaS domain checks and CAPI Lead logic, and it has regressed
 * twice. Nothing here can break the quiz.
 *
 * Modelled on iClosed: contact details come first, and the lead is captured the
 * moment they hand them over, not when they leave the page.
 *
 * Kinds of POST:
 *   - "potential": name + email + phone given on step 1. Notifies straight away.
 *   - "partial":   later answers, debounced. Stored only.
 *   - "update":    sent once by the page if they leave partway after answering
 *                  more questions, so you see how far they got. Notifies.
 *   - "submit":    the finished application, sent right before Cal opens. Notifies.
 *   - "disqualified": picked Under $5K spend. The page stops them before Cal, so
 *                  they never book or touch the pixel. Notifies so you don't chase them.
 *   ("abandoned" is still accepted as an alias of "update" for cached pages.)
 *
 * Storage:
 *   1. KV (env.LEADS) if bound. Every kind, keyed bf:<sid>, latest snapshot wins.
 *      No quota. Bind a KV namespace as LEADS in
 *      Cloudflare -> Pages -> Settings -> Functions -> KV bindings.
 *   2. Formspree (env.LEAD_WEBHOOK, default "Quiz Leads" xyeglebv). Free plan =
 *      50 submissions/month shared with the quiz, so "partial" never goes there,
 *      and nothing goes there without a real email or phone number.
 *      Formshield must stay OFF on that form, or server POSTs land in spam.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const FIELDS = ['name', 'email', 'phone', 'website', 'spend', 'category', 'channels', 'makers', 'timing'];
const clip = (v, n = 300) => String(v == null ? '' : v).slice(0, n).trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i;
const phoneOk = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 7 && d.length <= 15; };

// Spend bands that can carry a $4,000/month creative package.
const QUALIFIED_SPEND = new Set(['5-20k', '20-50k', '50k+']);
const SPEND_LABEL = { 'under-5k': 'Under $5K', '5-20k': '$5K-$20K', '20-50k': '$20K-$50K', '50k+': '$50K+' };

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

  let kind = body.kind === 'abandoned' ? 'update' : body.kind;
  if (!['potential', 'partial', 'update', 'submit', 'disqualified'].includes(kind)) kind = 'partial';
  const sid = clip(body.sid, 64).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sid) return json({ ok: false, error: 'no_sid' }, 400);

  const a = body.answers || {};
  const answers = {};
  for (const f of FIELDS) {
    const v = Array.isArray(a[f]) ? a[f].map((x) => clip(x, 40)).slice(0, 8).join(', ') : clip(a[f]);
    if (v) answers[f] = v;
  }
  // Drop anything half-typed so it can't trigger a notification or pollute the record.
  if (answers.email && !EMAIL_RE.test(answers.email)) delete answers.email;
  if (answers.phone && !phoneOk(answers.phone)) delete answers.phone;
  if (answers.website && !DOMAIN_RE.test(answers.website)) delete answers.website;

  const qualified = QUALIFIED_SPEND.has(answers.spend || '');
  const record = {
    sid, kind, ts: new Date().toISOString(), step: clip(body.step, 20), answers, qualified,
    page: clip(body.page, 200), utm: clip(body.utm, 300), country: request.headers.get('CF-IPCountry') || '',
  };

  // 1. KV: every event, one record per visitor.
  let stored = false;
  if (env.LEADS) {
    try { await env.LEADS.put(`bf:${sid}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 }); stored = true; }
    catch (e) { console.error('KV write failed', e); }
  }

  // 2. Formspree: only for leads we can actually reach.
  const reachable = Boolean(answers.email || answers.phone);
  let notified = false;
  if (kind !== 'partial' && reachable) {
    const who = answers.name || answers.email || answers.phone;
    const fit = qualified ? 'fits' : (answers.spend ? 'below budget' : 'budget unknown');
    const subject = {
      potential: `New Black Friday lead: ${who}`,
      update: `Black Friday lead stopped at question ${record.step} (${fit}): ${who}`,
      submit: `Black Friday application submitted (${fit}): ${who}`,
      disqualified: `Black Friday lead disqualified (under $5K spend): ${who}`,
    }[kind];
    try {
      const r = await fetch(env.LEAD_WEBHOOK || 'https://formspree.io/f/xyeglebv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: subject,
          source: 'black-friday-ads',
          status: { potential: 'potential', update: 'stopped partway', submit: 'submitted', disqualified: 'disqualified' }[kind],
          last_question: record.step,
          name: answers.name || '',
          email: answers.email || '',
          phone: answers.phone || '',
          website: answers.website || '',
          spend: SPEND_LABEL[answers.spend] || '',
          category: answers.category || '',
          channels: answers.channels || '',
          makers: answers.makers || '',
          timing: answers.timing || '',
          utm: record.utm, country: record.country, sid,
        }),
      });
      notified = r.ok;
    } catch (e) { console.error('webhook failed', e); }
  }

  return json({ ok: true, kind, stored, notified, qualified });
}
