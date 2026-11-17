import { api } from 'sdk';
import { db } from 'sdk/db';
import { and, desc, eq } from 'sdk/db';
import { entityHistory } from '../schema.js';
import { CREATION_DATE_SAMPLES } from '../data/creation-date-samples.js';

const HELP = [
  '🔎 BikaIDChecker',
  '',
  '• Send a public group/channel @username or t.me link.',
  '• Use the share buttons to get a user, bot, group, or channel ID.',
  '• Forward a message to inspect its visible sender/origin.',
  '• Old Names / Old Usernames buttons show up to ten previous values recorded by this bot.',
  '',
  '🗓 Account Created Date',
  'User accounts show an approximate date estimated from public ID samples. It is not an official Telegram date.',
  '',
  '✨ Custom Emoji tools',
  '• Send a Telegram Premium custom emoji to get its custom_emoji_id.',
  '• /idemoji <custom_emoji_id> — get the associated emoji from an ID.',
  '• /emojiid — send a custom emoji to read its ID.',
  'Standard Unicode emoji do not have Telegram custom emoji IDs.',
  '',
  '/start or /help — show this help'
].join('\n');

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function parsePublicUsername(input) {
  const value = String(input ?? '').trim();
  const reservedPaths = new Set([
    'addstickers', 'addemoji', 'share', 'proxy', 'socks',
    'login', 'confirmphone', 'iv', 'setlanguage', 'joinchat'
  ]);

  const link = value.match(/^(?:(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/)(?:s\/)?([A-Za-z0-9_]{5,})(?:[/?#].*)?$/i);
  if (link && !reservedPaths.has(link[1].toLowerCase())) return '@' + link[1];

  const tgResolve = value.match(/^tg:\/\/resolve\?([^#]+)$/i);
  if (tgResolve) {
    const domain = new URLSearchParams(tgResolve[1]).get('domain');
    if (domain && /^[A-Za-z0-9_]{5,}$/.test(domain) && !reservedPaths.has(domain.toLowerCase())) {
      return '@' + domain;
    }
  }

  const username = value.match(/^@?([A-Za-z0-9_]{5,})$/);
  if (username && !reservedPaths.has(username[1].toLowerCase())) return '@' + username[1];
  return null;
}

function picker() {
  return {
    keyboard: [
      [{ text: '👤 Share user', request_users: { request_id: 8101, user_is_bot: false, max_quantity: 1, request_name: true, request_username: true } }],
      [{ text: '🤖 Share bot', request_users: { request_id: 8102, user_is_bot: true, max_quantity: 1, request_name: true, request_username: true } }],
      [{ text: '👥 Share group', request_chat: { request_id: 8103, chat_is_channel: false, request_title: true, request_username: true } }],
      [{ text: '📢 Share channel', request_chat: { request_id: 8104, chat_is_channel: true, request_title: true, request_username: true } }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: 'Send @username or choose a share button'
  };
}

async function reply(chatId, text, extra = {}) {
  return api.sendMessage({ chat_id: chatId, text, ...extra });
}

function privatePicker(message) {
  return message.chat.type === 'private' ? { reply_markup: picker() } : {};
}

function buildMonotonicSamples() {
  const sorted = CREATION_DATE_SAMPLES
    .map(({ id, date }) => ({ id: Number(id), timestamp: Date.parse(date + 'T00:00:00Z') }))
    .filter(item => Number.isSafeInteger(item.id) && item.id >= 0 && Number.isFinite(item.timestamp))
    .sort((a, b) => a.id - b.id);

  // The public sample set contains noisy/non-monotonic observations. Pool adjacent
  // violations so the interpolation curve never moves backwards in time.
  const blocks = [];
  for (const item of sorted) {
    blocks.push({ first: item.id, last: item.id, sum: item.timestamp, count: 1 });
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.sum / left.count <= right.sum / right.count) break;
      blocks.splice(blocks.length - 2, 2, {
        first: left.first,
        last: right.last,
        sum: left.sum + right.sum,
        count: left.count + right.count
      });
    }
  }

  const anchors = [];
  for (const block of blocks) {
    const timestamp = block.sum / block.count;
    anchors.push({ id: block.first, timestamp });
    if (block.last !== block.first) anchors.push({ id: block.last, timestamp });
  }
  return anchors;
}

const CREATION_ANCHORS = buildMonotonicSamples();

function estimateAccountCreated(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0 || CREATION_ANCHORS.length < 2) return null;

  const first = CREATION_ANCHORS[0];
  const last = CREATION_ANCHORS[CREATION_ANCHORS.length - 1];
  if (id < first.id || id > last.id) return null;

  let low = 0;
  let high = CREATION_ANCHORS.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (CREATION_ANCHORS[mid].id < id) low = mid + 1;
    else high = mid - 1;
  }

  const upper = CREATION_ANCHORS[Math.min(low, CREATION_ANCHORS.length - 1)];
  if (upper.id === id || low === 0) {
    return new Date(upper.timestamp).toISOString().slice(0, 10);
  }
  const lower = CREATION_ANCHORS[low - 1];
  const ratio = (id - lower.id) / (upper.id - lower.id);
  const timestamp = lower.timestamp + ratio * (upper.timestamp - lower.timestamp);
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function recordHistory(data) {
  const entityType = ['User', 'Bot'].includes(data.kind) ? 'user' : 'chat';
  const entityId = String(data.id);
  const values = [
    { field: 'name', value: String(data.name ?? '').trim() },
    { field: 'username', value: String(data.username ?? '').trim().replace(/^@/, '') }
  ].filter(item => item.field === 'username' || item.value);

  for (const item of values) {
    const whereEntityField = and(
      eq(entityHistory.entityType, entityType),
      eq(entityHistory.entityId, entityId),
      eq(entityHistory.field, item.field)
    );
    const latest = await db.select({ value: entityHistory.value })
      .from(entityHistory)
      .where(whereEntityField)
      .orderBy(desc(entityHistory.observedAt), desc(entityHistory.id))
      .limit(1)
      .get();

    // Record a new event only when the observed value changes from the latest value.
    if (!latest || latest.value !== item.value) {
      await db.insert(entityHistory).values({
        entityType,
        entityId,
        field: item.field,
        value: item.value,
        observedAt: Math.floor(Date.now() / 1000)
      }).run();
    }

    // Retain the latest occurrence of the current value plus ten previous distinct values.
    const allRows = await db.select({ id: entityHistory.id, value: entityHistory.value })
      .from(entityHistory)
      .where(whereEntityField)
      .orderBy(desc(entityHistory.observedAt), desc(entityHistory.id))
      .all();

    const seen = new Set();
    const keep = new Set();
    for (const row of allRows) {
      if (seen.has(row.value)) continue;
      seen.add(row.value);
      if (seen.size <= 11) keep.add(row.id);
    }

    for (const row of allRows) {
      if (!keep.has(row.id)) {
        await db.delete(entityHistory).where(eq(entityHistory.id, row.id)).run();
      }
    }
  }
}

async function historyButton(entityType, entityId, field, label) {
  const rows = await db.select({ value: entityHistory.value })
    .from(entityHistory)
    .where(and(
      eq(entityHistory.entityType, entityType),
      eq(entityHistory.entityId, String(entityId)),
      eq(entityHistory.field, field)
    ))
    .orderBy(desc(entityHistory.observedAt), desc(entityHistory.id))
    .limit(11)
    .all();
  const current = rows[0]?.value;
  const oldCount = rows.filter(row => row.value !== current && (field !== 'username' || row.value)).length;
  return oldCount > 0
    ? { text: label + ' (' + oldCount + ')', callback_data: 'history:' + (entityType === 'user' ? 'u' : 'c') + ':' + String(entityId) + ':' + (field === 'name' ? 'n' : 'u') }
    : null;
}

async function result(chatId, data) {
  await recordHistory(data);
  const entityType = ['User', 'Bot'].includes(data.kind) ? 'user' : 'chat';
  const nameButton = await historyButton(entityType, data.id, 'name', '📜 Old Names');
  const usernameButton = await historyButton(entityType, data.id, 'username', '🔗 Old Usernames');
  const historyButtons = [nameButton, usernameButton].filter(Boolean);

  const lines = [
    '🔎 <b>Telegram ID Information</b>',
    '',
    '<b>Type:</b> ' + esc(data.kind),
    '<b>Name:</b> ' + esc(data.name || 'Not provided'),
    data.username ? '<b>Username:</b> ' + esc(data.username.startsWith('@') ? data.username : '@' + data.username) : null,
    '<b>ID:</b> <code>' + esc(data.id) + '</code>',
    data.kind === 'User'
      ? '<b>Account created:</b> ' + (estimateAccountCreated(data.id)
        ? '≈ ' + esc(estimateAccountCreated(data.id)) + ' <i>(estimated)</i>'
        : 'Estimate unavailable for this ID range')
      : null
  ].filter(Boolean);

  const keyboard = [[{ text: '📋 Copy ID', copy_text: { text: String(data.id) } }]];
  if (historyButtons.length) keyboard.push(historyButtons);

  return reply(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function lookupChat(chatId, username) {
  try {
    const chat = await api.getChat({ chat_id: username });
    const kind = chat.type === 'channel' ? 'Channel' : chat.type === 'supergroup' ? 'Supergroup' : chat.type === 'group' ? 'Group' : 'Chat';
    await result(chatId, {
      kind,
      name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' '),
      username: chat.username,
      id: chat.id
    });
  } catch {
    await reply(chatId, '❌ Username could not be resolved. Direct lookup supports public groups, supergroups, and channels only. Telegram Bot API cannot look up arbitrary personal users or bots by username. Use Share user / Share bot in a private chat, or forward a message with a visible sender.');
  }
}

async function sharedUsers(message) {
  const shared = message.users_shared;
  const users = shared?.users;
  if (!Array.isArray(users) || users.length === 0) return false;
  for (const user of users) {
    await result(message.chat.id, {
      kind: user.is_bot || shared.request_id === 8102 ? 'Bot' : 'User',
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Shared account',
      username: user.username,
      id: user.user_id
    });
  }
  return true;
}

async function sharedChat(message) {
  const chat = message.chat_shared;
  if (!chat?.chat_id) return false;
  await result(message.chat.id, {
    kind: 'Group / Channel',
    name: chat.title || 'Shared chat',
    username: chat.username,
    id: chat.chat_id
  });
  return true;
}

async function forwarded(message) {
  const origin = message.forward_origin;
  if (!origin) return false;

  if (origin.type === 'user' && origin.sender_user) {
    const user = origin.sender_user;
    await result(message.chat.id, { kind: user.is_bot ? 'Bot' : 'User', name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username, id: user.id });
    return true;
  }
  if (origin.type === 'chat' && origin.sender_chat) {
    const chat = origin.sender_chat;
    await result(message.chat.id, { kind: 'Group', name: chat.title, username: chat.username, id: chat.id });
    return true;
  }
  if (origin.type === 'channel' && origin.chat) {
    const chat = origin.chat;
    await result(message.chat.id, { kind: 'Channel', name: chat.title, username: chat.username, id: chat.id });
    return true;
  }
  if (origin.type === 'hidden_user') {
    await reply(message.chat.id, '⚠️ This forward hides the original sender. Telegram does not provide that user’s ID.');
    return true;
  }
  return false;
}

async function emojiToId(message) {
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];
  const customEntities = entities.filter(entity => entity.type === 'custom_emoji' && entity.custom_emoji_id);
  if (customEntities.length === 0) return false;

  const sourceText = String(message.text ?? message.caption ?? '');
  const lines = customEntities.map(entity => {
    const emoji = sourceText.slice(entity.offset, entity.offset + entity.length);
    return '<b>Emoji:</b> ' + esc(emoji || 'Custom emoji') + '\n<b>Custom Emoji ID:</b> <code>' + esc(entity.custom_emoji_id) + '</code>';
  });
  await reply(message.chat.id, '✨ <b>Emoji to ID</b>\n\n' + lines.join('\n\n'), { parse_mode: 'HTML' });
  return true;
}

async function idToEmoji(chatId, customEmojiId) {
  if (!/^\d{8,25}$/.test(customEmojiId)) {
    await reply(chatId, '❌ Please provide a valid numeric custom emoji ID. Example: /idemoji 5368324170671202286');
    return;
  }

  try {
    const stickers = await api.getCustomEmojiStickers({ custom_emoji_ids: [customEmojiId] });
    const sticker = Array.isArray(stickers)
      ? stickers.find(item => String(item.custom_emoji_id) === customEmojiId) || stickers[0]
      : null;

    if (!sticker) {
      await reply(chatId, '❌ No custom emoji was found for that ID. It may be invalid or deleted.');
      return;
    }

    const lines = [
      '✨ <b>ID to Emoji</b>',
      '',
      '<b>Emoji:</b> ' + esc(sticker.emoji || 'No base emoji provided'),
      '<b>Custom Emoji ID:</b> <code>' + esc(customEmojiId) + '</code>',
      sticker.set_name ? '<b>Sticker set:</b> ' + esc(sticker.set_name) : null
    ].filter(Boolean);
    await reply(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  } catch {
    await reply(chatId, '❌ Could not resolve this custom emoji ID. It may be invalid, deleted, or unavailable to the Bot API.');
  }
}

export default async function (message) {
  if (!message?.chat?.id) return;

  if (await sharedUsers(message)) return;
  if (await sharedChat(message)) return;
  if (await emojiToId(message)) return;
  if (await forwarded(message)) return;

  const text = String(message.text ?? '').trim();
  if (text === '/start' || text.startsWith('/start@') || text === '/help' || text.startsWith('/help@')) {
    await reply(message.chat.id, HELP, privatePicker(message));
    return;
  }

  if (text === '/emojiid' || text.startsWith('/emojiid@')) {
    await reply(message.chat.id, 'Send a Telegram Premium custom emoji in your next message. I will return its custom_emoji_id. Standard emoji do not have a custom ID.');
    return;
  }

  const idMatch = text.match(/^\/idemoji(?:@\w+)?\s+(\d{8,25})$/i);
  if (idMatch) {
    await idToEmoji(message.chat.id, idMatch[1]);
    return;
  }

  const username = parsePublicUsername(text);
  if (username) {
    await lookupChat(message.chat.id, username);
    return;
  }

  if (text.startsWith('/')) {
    await reply(message.chat.id, 'Unknown command. Send /help for instructions.');
    return;
  }

  await reply(message.chat.id, 'Send a public group/channel username, @username, t.me link, or Telegram resolve link. Bot API cannot look up arbitrary personal users or bots by username; use Share user / Share bot in a private chat or forward a message with a visible sender. For custom emoji, send a Premium custom emoji or use /idemoji <id>.');
}
