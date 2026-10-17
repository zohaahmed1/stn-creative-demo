/**
 * Every contactable lead -> one row in the "STN Leads" Google Sheet.
 *
 * Rows are POSTed as JSON to env.SHEET_WEBHOOK: the Apps Script web app bound to
 * the sheet ("STN Leads - website webhook"), or a Make custom webhook if that
 * ever replaces it. Either way the receiver appends one row per POST. The URL is
 * set in Cloudflare -> Pages -> Settings -> Variables, not here, because this
 * repo is public and anyone could post junk rows to it. Unset means skip, so
 * nothing breaks before it's configured.
 *
 * Formspree's free plan only keeps 30 days and 50 submissions a month. The sheet
 * is the permanent list. KV (env.LEADS) is the raw backup.
 *
 * Every funnel sends the same keys, so the sheet columns never shift. The sheet's
 * "Leads" tab has them in this order: Date, Source, Status, Name, Email, Phone,
 * Company, Website, Ad spend, Channels, Who makes ads, Formats, Ongoing, Timing,
 * Notes, Country, UTM, Page, ID.
 */

export const SHEET_KEYS = [
  'date', 'source', 'status', 'name', 'email', 'phone', 'company', 'website',
  'spend', 'channels', 'makers', 'formats', 'ongoing', 'timing', 'notes',
  'country', 'utm', 'page', 'id',
];

// "2026-10-17 00:51", Toronto time, so the sheet sorts and reads without formulas.
const stamp = (d = new Date()) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch (_) { return d.toISOString(); }
};

export async function toSheet(env, row) {
  if (!env.SHEET_WEBHOOK) return false;
  const body = {};
  for (const k of SHEET_KEYS) body[k] = String(row[k] == null ? '' : row[k]).slice(0, 500).trim();
  if (!body.date) body.date = stamp();
  try {
    const r = await fetch(env.SHEET_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch (e) { console.error('sheet webhook failed', e); return false; }
}
