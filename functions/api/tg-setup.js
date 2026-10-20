/* One-time link between the lead-alert bot and Zoha's Telegram chat.
 *
 * Zoha sends a short code to her bot, then GET /api/tg-setup?code=<that code>.
 * The chat that sent exactly that code is saved in KV (tg:chat) and gets a confirmation.
 * Once a chat is saved this endpoint refuses, so nobody else can redirect the alerts.
 * To move alerts to another chat, delete tg:chat in KV (or set TELEGRAM_CHAT_ID).
 */

import { botToken } from '../../lib/telegram.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestGet({ request, env }) {
  const token = botToken(env);
  if (!token) return json({ ok: false, error: env.TELEGRAM_BOT_TOKEN ? 'token_unreadable' : 'no_token' }, 400);
  if (!env.LEADS) return json({ ok: false, error: 'no_kv' }, 500);
  if (env.TELEGRAM_CHAT_ID || (await env.LEADS.get('tg:chat'))) return json({ ok: false, error: 'already_set' }, 409);

  const code = (new URL(request.url).searchParams.get('code') || '').trim().toUpperCase();
  if (code.length < 6) return json({ ok: false, error: 'bad_code' }, 400);

  const api = `https://api.telegram.org/bot${token}`;
  const res = await fetch(`${api}/getUpdates`);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return json({ ok: false, error: 'telegram_error', telegram: { code: data.error_code, description: data.description } }, 502);

  const msg = (data.result || []).map((u) => u.message).filter(Boolean).reverse()
    .find((m) => m.chat && m.chat.type === 'private' && String(m.text || '').trim().toUpperCase() === code);
  if (!msg) return json({ ok: false, error: 'code_not_found' }, 404);

  await env.LEADS.put('tg:chat', String(msg.chat.id));
  await fetch(`${api}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: msg.chat.id, text: '✅ Lead alerts are on. You’ll get a message here when someone picks $10K+ on the Black Friday form, and again when they finish it.' }),
  });
  return json({ ok: true });
}
