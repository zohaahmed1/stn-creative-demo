/**
 * Free SaaS-domain validation, ported from the May 2026 6k-list method that
 * validated 2,364 companies without any enrichment subscription.
 *
 * Signals, in order of strength:
 *   1. MX records        — baseline. No MX means it is not a real mail domain.
 *   2. App subdomain     — app/login/dashboard/... resolving is the strongest
 *                          single SaaS signal (1,326 of 2,364 companies had one).
 *   3. Pricing page      — ONE-WAY only. Presence confirms; absence proves nothing,
 *                          because ~75% of genuine SaaS hide behind "contact sales".
 *
 * Deliberately does NOT try to verify claimed ARR. Nothing free can do that. This
 * kills the junk that matters most on broad targeting: leads that are not a
 * software company at all.
 */

const APP_SUBDOMAINS = ['app', 'login', 'dashboard', 'portal', 'admin', 'console'];
const PRICING_PATHS = ['/pricing', '/plans', '/price'];
const PRICING_HINTS = /\b(per month|\/mo\b|per user|billed annually|free trial|start free|contact sales|per seat)\b/i;

async function dohQuery(name, type) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(2500) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.Answer) && data.Answer.length > 0;
  } catch (_) {
    return null; // network/timeout — treated as unknown, never as a fail
  }
}

async function hasPricingPage(domain) {
  for (const path of PRICING_PATHS) {
    try {
      const res = await fetch(`https://${domain}${path}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(3500),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; STNQuizBot/1.0)' },
      });
      if (!res.ok) continue;
      const html = (await res.text()).slice(0, 120000);
      if (PRICING_HINTS.test(html)) return true;
    } catch (_) { /* try the next path */ }
  }
  return false;
}

/** Returns { verified, signals, reason } — never throws. */
export async function verifyDomain(domain) {
  const signals = { mx: null, appSubdomain: false, pricingPage: false, checkedSubdomain: null };

  const mx = await dohQuery(domain, 'MX');
  signals.mx = mx;
  if (mx === false) {
    return { verified: false, signals, reason: 'no_mx_records' };
  }

  for (const sub of APP_SUBDOMAINS) {
    const hit = await dohQuery(`${sub}.${domain}`, 'A');
    if (hit) { signals.appSubdomain = true; signals.checkedSubdomain = sub; break; }
  }

  if (!signals.appSubdomain) {
    signals.pricingPage = await hasPricingPage(domain);
  }

  const verified = signals.appSubdomain || signals.pricingPage;
  return {
    verified,
    signals,
    reason: verified
      ? (signals.appSubdomain ? 'app_subdomain' : 'pricing_page')
      : 'no_saas_signal',
  };
}

/** Pulls a bare hostname out of whatever the user typed. */
export function normaliseDomain(input) {
  let v = String(input || '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].split('@').pop();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return '';
  return v;
}
