/* Cal.com booking webhook -> Meta Conversions API (server-side Schedule).
 *
 * Cloudflare Pages Functions format. The old api/cal-webhook.js was written for
 * Vercel (module.exports handler(req,res)) and never executed here — Pages only
 * runs functions/**, so that URL 404'd and every booking went untracked.
 *
 * Dedup: event_id is derived from Cal's booking uid, and the browser fires the
 * same id via fbq(..., {eventID}). Meta collapses the pair into one Schedule.
 * If the uid is ever missing the event still sends; a duplicate beats a miss.
 *
 * Requires META_CONVERSION_TOKEN in the Cloudflare Pages environment.
 */

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value).toLowerCase().trim());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ received: true, error: 'invalid JSON body' });
  }

  const { triggerEvent, payload } = body || {};
  if (triggerEvent !== 'BOOKING_CREATED') {
    return json({ received: true, skipped: triggerEvent || 'none' });
  }

  try {
    const accessToken = env.META_CONVERSION_TOKEN;
    if (!accessToken) return json({ received: true, error: 'META_CONVERSION_TOKEN not set' });

    const pixelId = env.META_PIXEL_ID || '1906222660310524';
    const { attendees, title, startTime, uid } = payload || {};
    const attendee = (attendees && attendees[0]) || {};
    const nameParts = (attendee.name || '').trim().split(/\s+/);

    // Same id the browser sends, so Meta dedupes the client and server copies.
    const eventId = uid ? `cal_${uid}` : `cal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // fbp/fbc only exist if they were captured into booking questions.
    const meta = payload?.metadata || payload?.responses || {};
    const fbp = meta.fbp || undefined;
    const fbc = meta.fbc || undefined;

    const tz = attendee.timeZone || '';
    let country;
    if (tz.includes('Canada') || /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax)/.test(tz)) country = await sha256('ca');
    else if (tz.startsWith('America/')) country = await sha256('us');

    const user_data = {};
    if (attendee.email) {
      const em = await sha256(attendee.email);
      user_data.em = [em];
      user_data.external_id = [em];
    }
    if (nameParts[0]) user_data.fn = [await sha256(nameParts[0])];
    if (nameParts.length > 1) user_data.ln = [await sha256(nameParts[nameParts.length - 1])];
    if (country) user_data.country = [country];
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;

    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for');
    if (ip) user_data.client_ip_address = ip.split(',')[0].trim();
    const ua = request.headers.get('user-agent');
    if (ua) user_data.client_user_agent = ua;

    const res = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          {
            event_name: 'Schedule',
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            action_source: 'website',
            event_source_url: 'https://skipthenoisemedia.com/',
            user_data,
            custom_data: { event_name: title, booking_time: startTime },
          },
        ],
        access_token: accessToken,
      }),
    });

    const data = await res.json();
    if (!res.ok) return json({ received: true, meta_error: data?.error?.message || data });

    return json({ success: true, event_id: eventId, events_received: data?.events_received, fbtrace_id: data?.fbtrace_id });
  } catch (err) {
    // Always 200 — Cal retries on non-2xx and we don't want a loop over a bad payload.
    return json({ received: true, error: String(err) });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ error: 'Method not allowed' }, 405);
}
