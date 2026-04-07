export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook secret if provided
  const webhookSecret = process.env.CAL_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = req.headers['x-cal-signature'];
    if (!signature || signature !== webhookSecret) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const { triggerEvent, payload } = req.body;

  // Only process booking creation events
  if (triggerEvent !== 'booking.created') {
    return res.status(200).json({ received: true });
  }

  try {
    const { attendees, title, startTime } = payload;
    const attendeeEmail = attendees?.[0]?.email;

    // Hash email for Meta
    let hashedEmail;
    if (attendeeEmail) {
      const crypto = require('crypto');
      hashedEmail = crypto
        .createHash('sha256')
        .update(attendeeEmail.toLowerCase().trim())
        .digest('hex');
    }

    // Fire Meta Conversions API
    const pixelId = process.env.META_PIXEL_ID || '190622266031524';
    const accessToken = process.env.META_CONVERSION_TOKEN;

    if (!accessToken) {
      console.error('META_CONVERSION_TOKEN not set');
      return res.status(200).json({ warning: 'Token not configured' });
    }

    const metaResponse = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              event_name: 'Lead',
              event_time: Math.floor(Date.now() / 1000),
              event_id: `cal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              user_data: {
                em: hashedEmail,
                phone: attendees?.[0]?.phoneNumber ?
                  require('crypto').createHash('sha256')
                    .update(attendees[0].phoneNumber.toLowerCase().replace(/\D/g, ''))
                    .digest('hex') : undefined,
                fn: attendees?.[0]?.name ?
                  require('crypto').createHash('sha256')
                    .update(attendees[0].name.split(' ')[0].toLowerCase())
                    .digest('hex') : undefined,
                ln: attendees?.[0]?.name && attendees[0].name.includes(' ') ?
                  require('crypto').createHash('sha256')
                    .update(attendees[0].name.split(' ')[1].toLowerCase())
                    .digest('hex') : undefined
              },
              custom_data: {
                event_name: title,
                booking_time: startTime
              }
            }
          ],
          access_token: accessToken
        })
      }
    );

    const metaData = await metaResponse.json();

    if (!metaResponse.ok) {
      console.error('Meta API error:', metaData);
      // Still return 200 to acknowledge webhook receipt
      return res.status(200).json({
        received: true,
        meta_error: metaData.error?.message
      });
    }

    console.log('Meta conversion tracked:', metaData);
    return res.status(200).json({
      success: true,
      meta_response: metaData
    });
  } catch (error) {
    console.error('Webhook error:', error);
    // Return 200 to prevent Cal.com from retrying
    return res.status(200).json({
      received: true,
      error: error.message
    });
  }
}
