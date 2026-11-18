import { api, fetch } from 'sdk';
import { db } from 'sdk/db';
import { and, desc, eq } from 'sdk/db';
import { entityHistory, resolverConfig, accountNameHistory } from '../schema.js';

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
  const darkcamsMatch = callbackData.match(/^darkcams:(username|name):([1-9][0-9]{0,19})$/);
  if (darkcamsMatch) {
    const field = darkcamsMatch[1];
    const entityId = darkcamsMatch[2];
    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'Fetching history...' });
    try {
      let snapshot = await db.select({
        rawText: accountNameHistory.rawText,
        namesJson: accountNameHistory.namesJson,
        usernamesJson: accountNameHistory.usernamesJson,
        fetchedAt: accountNameHistory.fetchedAt
      }).from(accountNameHistory)
        .where(eq(accountNameHistory.entityId, entityId))
        .orderBy(desc(accountNameHistory.fetchedAt), desc(accountNameHistory.id))
        .limit(1).get();

      // The first History button fetches both lists from DARKC4MSHOW.
      // The second button reuses that same saved Names-page response.
      if (!snapshot || Math.floor(Date.now() / 1000) - Number(snapshot.fetchedAt) > 86400) {
        const config = await db.select({ apiKey: resolverConfig.apiKey })
          .from(resolverConfig).where(eq(resolverConfig.id, 1)).get();
        if (!config?.apiKey) throw new Error('Resolver is not configured. Ask the owner to run /setresolver privately.');
        const response = await fetch('https://bikaidchecker-mtproto-resolver-iyzh.onrender.com/v1/darkcams/names', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
          body: JSON.stringify({ user_id: entityId })
        });
        let body = {};
        try { body = await response.json(); } catch {}
        if (!response.ok || body.ok !== true) {
          throw new Error(typeof body.detail === 'string' ? body.detail : 'DARKC4MSHOW request failed.');
        }

        const fetchedAt = Number(body.fetched_at) || Math.floor(Date.now() / 1000);
        await db.insert(accountNameHistory).values({
          entityId,
          rawText: String(body.raw_text ?? ''),
          namesJson: JSON.stringify(Array.isArray(body.names) ? body.names : []),
          usernamesJson: JSON.stringify(Array.isArray(body.usernames) ? body.usernames : []),
          fetchedAt
        }).run();
        const savedRows = await db.select({ id: accountNameHistory.id })
          .from(accountNameHistory).where(eq(accountNameHistory.entityId, entityId))
          .orderBy(desc(accountNameHistory.fetchedAt), desc(accountNameHistory.id)).all();
        for (const row of savedRows.slice(5)) {
          await db.delete(accountNameHistory).where(eq(accountNameHistory.id, row.id)).run();
        }
        snapshot = {
          rawText: String(body.raw_text ?? ''),
          namesJson: JSON.stringify(Array.isArray(body.names) ? body.names : []),
          usernamesJson: JSON.stringify(Array.isArray(body.usernames) ? body.usernames : []),
          fetchedAt
        };
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
          ? selected.slice(0, 30).map((item, index) => {
              const entry = typeof item === 'string' ? { value: item, date: '' } : item;
              const value = (field === 'name'
                ? String(entry.value ?? '')
                : '@' + String(entry.value ?? '').replace(/^@/, '')).slice(0, 100);
              const date = entry.date ? ' <i>[' + esc(entry.date) + ']</i>' : '';
              return (index + 1) + '. ' + esc(value) + date;
            })
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
    } catch (error) {
      console.error('DARKC4MSHOW history lookup failed:', String(error?.message ?? 'unknown error'));
      if (query.message?.chat?.id) {
        await api.sendMessage({
          chat_id: query.message.chat.id,
          text: '❌ Could not load history right now. Please try again shortly.',
          reply_to_message_id: query.message.message_id,
          allow_sending_without_reply: true
        });
      }
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
