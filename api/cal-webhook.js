const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { triggerEvent, payload } = req.body;

  if (triggerEvent !== 'BOOKING_CREATED') {
    return res.status(200).json({ received: true, skipped: triggerEvent, v: 3 });
  }

  try {
    const { attendees, title, startTime } = payload || {};
    const attendee = attendees?.[0] || {};
    const pixelId = process.env.META_PIXEL_ID || '1906222660310524';
    const accessToken = process.env.META_CONVERSION_TOKEN;

    if (!accessToken) {
      return res.status(200).json({ error: 'META_CONVERSION_TOKEN not set' });
    }

    const nameParts = (attendee.name || '').split(' ');

    // Extract fbp/fbc from custom metadata if passed via booking questions
    const metadata = payload?.metadata || payload?.responses || {};
    const fbp = metadata.fbp || undefined;
    const fbc = metadata.fbc || undefined;

    // Infer country from timezone if available
    const tz = attendee.timeZone || payload?.attendees?.[0]?.timeZone || '';
    let country;
    if (tz.startsWith('America/Toronto') || tz.startsWith('America/Vancouver') || tz.includes('Canada')) country = sha256('ca');
    else if (tz.startsWith('America/')) country = sha256('us');

    const eventData = {
      data: [
        {
          event_name: 'Schedule',
          event_time: Math.floor(Date.now() / 1000),
          event_id: `cal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          action_source: 'website',
          event_source_url: 'https://skipthenoisemedia.com/creative-audit',
          user_data: {
            em: attendee.email ? [sha256(attendee.email)] : undefined,
            fn: nameParts[0] ? [sha256(nameParts[0])] : undefined,
            ln: nameParts[1] ? [sha256(nameParts[1])] : undefined,
            external_id: attendee.email ? [sha256(attendee.email)] : undefined,
            country: country ? [country] : undefined,
            fbp: fbp || undefined,
            fbc: fbc || undefined,
            client_ip_address: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || undefined,
            client_user_agent: req.headers['user-agent'] || undefined,
          },
          custom_data: {
            event_name: title,
            booking_time: startTime,
          },
        },
      ],
      access_token: accessToken,
    };

    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData),
      }
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      return res.status(200).json({ received: true, meta_error: metaData?.error?.message || metaData });
    }

    return res.status(200).json({ success: true, events_received: metaData?.events_received, fbtrace_id: metaData?.fbtrace_id });
  } catch (err) {
    return res.status(200).json({ received: true, error: String(err) });
  }
}
