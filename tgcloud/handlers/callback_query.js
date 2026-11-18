import { api } from 'sdk';
import { db } from 'sdk/db';
import { and, desc, eq } from 'sdk/db';
import { entityHistory, sangmataHistory } from '../schema.js';

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function formatDate(timestamp) {
  if (!timestamp) return 'Date unavailable';
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

export default async function (query) {
  if (!query?.id) return;
  const callbackData = String(query.data ?? '');
  const sangmataMatch = callbackData.match(/^sangmata:(username|name):([1-9][0-9]{0,19})$/);
  if (sangmataMatch) {
    const field = sangmataMatch[1];\n    const entityId = sangmataMatch[2];
    try {
      const snapshot = await db.select({
        rawText: sangmataHistory.rawText,
        namesJson: sangmataHistory.namesJson,
        usernamesJson: sangmataHistory.usernamesJson,
        fetchedAt: sangmataHistory.fetchedAt
      }).from(sangmataHistory)
        .where(eq(sangmataHistory.entityId, entityId))
        .orderBy(desc(sangmataHistory.fetchedAt), desc(sangmataHistory.id))
        .limit(1).get();
      if (!snapshot) {
        await api.answerCallbackQuery({ callback_query_id: query.id, text: 'No saved SangMata result was found.', show_alert: true });
        return;
      }
      let names = [];
      let usernames = [];
      try { names = JSON.parse(snapshot.namesJson); } catch {}
      try { usernames = JSON.parse(snapshot.usernamesJson); } catch {}
      if (!Array.isArray(names)) names = [];
      if (!Array.isArray(usernames)) usernames = [];
      const selected = field === 'name' ? names : usernames;
      const title = field === 'name' ? '📜 <b>Name History</b>' : '🔗 <b>Username History</b>';
      const lines = [
        title,
        '',
        '<b>Telegram ID:</b> <code>' + esc(entityId) + '</code>',
        '<b>Fetched:</b> ' + esc(formatDate(snapshot.fetchedAt)),
        '',
        ...(selected.length
          ? selected.slice(0, 15).map((value, index) => (index + 1) + '. ' + esc(field === 'name' ? String(value).slice(0, 100) : '@' + String(value).replace(/^@/, '').slice(0, 100)))
          : [field === 'name' ? 'No name history returned.' : 'No username history returned.'])
      ];
      const chatId = query.message?.chat?.id;
      if (chatId) {
        await api.sendMessage({
          chat_id: chatId,
          text: lines.join('\n'),
          parse_mode: 'HTML',
          reply_to_message_id: query.message.message_id,
          allow_sending_without_reply: true
        });
      }
      await api.answerCallbackQuery({ callback_query_id: query.id });
    } catch (error) {
      console.error('SangMata history read failed:', String(error?.message ?? 'unknown error'));
      await api.answerCallbackQuery({ callback_query_id: query.id, text: 'Could not load saved SangMata history.', show_alert: true });
    }
    return;
  }

  const match = callbackData.match(/^history:([uc]):(-?\d+):([nu])$/);
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
