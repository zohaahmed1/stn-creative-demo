/* Checks that META_CONVERSION_TOKEN can still send Conversions API events.
 *
 * GET /api/capi-check sends ONE PageView flagged with test_event_code, so Meta counts it
 * as a test (it shows under Events Manager -> Test events, and never in reporting or
 * optimisation). It returns whether Meta accepted it. The token is never echoed.
 * Rate-limited to one check every 30 seconds through KV.
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestGet({ env }) {
  const token = env.META_CONVERSION_TOKEN;
  if (!token) return json({ ok: false, error: 'no_token' }, 400);
  if (env.LEADS) {
    if (await env.LEADS.get('capi-check:recent')) return json({ ok: false, error: 'wait_30s' }, 429);
    await env.LEADS.put('capi-check:recent', '1', { expirationTtl: 60 });
  }
  const pixelId = env.META_PIXEL_ID || '1906222660310524';
  const res = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      test_event_code: 'STNCHECK1',
      data: [{
        event_name: 'PageView',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: 'https://skipthenoisemedia.com/capi-check',
        user_data: { client_user_agent: 'stn-capi-check', client_ip_address: '203.0.113.7' },
      }],
      access_token: token,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return json({ ok: res.ok && data.events_received === 1, events_received: data.events_received, error: data.error ? data.error.message : undefined });
}
