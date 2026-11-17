import { api } from 'sdk';
import { db } from 'sdk/db';
import { and, desc, eq } from 'sdk/db';
import { entityHistory } from '../schema.js';

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function formatDate(timestamp) {
  if (!timestamp) return 'Date unavailable';
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

export default async function (query) {
  if (!query?.id) return;
  const match = String(query.data ?? '').match(/^history:([uc]):(-?\d+):([nu])$/);
  if (!match) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'This button is invalid or expired.', show_alert: true });
    return;
  }

  const entityType = match[1] === 'u' ? 'user' : 'chat';
  const entityId = match[2];
  const field = match[3] === 'n' ? 'name' : 'username';
  const title = field === 'name' ? '📜 Old Names' : '🔗 Old Usernames';

  try {
    const rows = await db.select({
      value: entityHistory.value,
      observedAt: entityHistory.observedAt
    }).from(entityHistory)
      .where(and(
        eq(entityHistory.entityType, entityType),
        eq(entityHistory.entityId, entityId),
        eq(entityHistory.field, field)
      ))
      .orderBy(desc(entityHistory.observedAt), desc(entityHistory.id))
      .limit(11)
      .all();

    const current = rows[0]?.value;
    // Empty username observations mark that a username was removed; they are
    // state markers, not historical usernames to display.
    const oldValues = rows
      .filter(row => row.value !== current && (field !== 'username' || row.value))
      .slice(0, 10);

    if (!oldValues.length) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: 'No previous values have been recorded yet.' });
      return;
    }

    const lines = [
      title,
      '',
      '<b>Telegram ID:</b> <code>' + esc(entityId) + '</code>',
      '',
      ...oldValues.map((row, index) => (index + 1) + '. ' + esc(field === 'username' ? '@' + row.value.replace(/^@/, '') : row.value) + '\n   <i>Last observed: ' + esc(formatDate(row.observedAt)) + '</i>'),
      '',
      '<i>History is recorded by this bot from the first time it sees a value. It cannot retrieve names or usernames from before tracking began.</i>'
    ];

    if (query.message?.chat?.id) {
      await api.sendMessage({
        chat_id: query.message.chat.id,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        reply_to_message_id: query.message.message_id,
        allow_sending_without_reply: true
      });
    }
    await api.answerCallbackQuery({ callback_query_id: query.id });
  } catch (error) {
    console.error('history lookup failed', error);
    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'Could not load history. Please try again.', show_alert: true });
  }
}
