/* Lead alerts to Zoha's phone through her own Telegram bot.
 *
 * Secrets (Cloudflare -> Pages -> stn-creative-demo -> Settings -> Variables and Secrets):
 *   TELEGRAM_BOT_TOKEN  the token @BotFather gave for the bot. Without it, alerts are off.
 *   TELEGRAM_CHAT_ID    optional. If unset, the chat registered through /api/tg-setup (kept in
 *                       KV as tg:chat) is used.
 *
 * The phone number goes in as plain text, so Telegram makes it tappable and it opens
 * the phone's normal dialer. Nothing here can block or slow the form.
 */

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function chatId(env) {
  if (env.TELEGRAM_CHAT_ID) return env.TELEGRAM_CHAT_ID;
  if (env.LEADS) { try { return await env.LEADS.get('tg:chat'); } catch (_) {} }
  return null;
}

export async function tgSend(env, html) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const chat = await chatId(env);
  if (!chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { console.error('telegram send failed', e); return false; }
}

// One message per lead moment. `stage` is 'qualified' (picked $10K+ but still on the form) or 'submitted'.
export function leadAlert(stage, { name, phone, email, website, spend, makers, timing, step }) {
  const tel = String(phone || '').replace(/[^\d+]/g, '');
  const head = stage === 'submitted'
    ? `✅ <b>${esc(name || 'BF lead')} finished the form</b>. Calendar is open`
    : `🔥 <b>New BF lead: ${esc(name || 'no name yet')}</b>`;
  return [
    head,
    [spend && `${esc(spend)}/mo`, makers && `ads by ${esc(makers)}`, timing && `start: ${esc(timing)}`].filter(Boolean).join(' · '),
    tel && `📞 ${esc(tel)}`,
    email && `✉️ ${esc(email)}`,
    website && `🌐 ${esc(website)}`,
    stage === 'qualified' ? `Still on the form (question ${esc(step || '?')} of 5). Call now.` : 'Call if they don’t book in the next few minutes.',
  ].filter(Boolean).join('\n');
}
