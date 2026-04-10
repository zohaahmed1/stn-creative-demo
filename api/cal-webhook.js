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

    const eventData = {
      data: [
        {
          event_name: 'Schedule',
          event_time: Math.floor(Date.now() / 1000),
          event_id: `cal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          action_source: 'website',
          user_data: {
            em: attendee.email ? [sha256(attendee.email)] : undefined,
            fn: nameParts[0] ? [sha256(nameParts[0])] : undefined,
            ln: nameParts[1] ? [sha256(nameParts[1])] : undefined,
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
