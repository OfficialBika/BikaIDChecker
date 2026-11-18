import { api, fetch } from 'sdk';
import { db } from 'sdk/db';
import { and, desc, eq } from 'sdk/db';
import { entityHistory, resolverConfig } from '../schema.js';
import { CREATION_DATE_SAMPLES } from '../lib/creation-date-samples.js';

const OWNER_ID = '8251006975';
const RESOLVER_BASE_URL = 'https://bikaidchecker-mtproto-resolver-iyzh.onrender.com';

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
  '/start or /help — show this help',
  'Use the keyboard icon beside the message field to show or hide the share menu.'
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

  // A numeric Telegram ID must never be interpreted as a public username.
  const username = value.match(/^@?([A-Za-z][A-Za-z0-9_]{4,})$/);
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
    one_time_keyboard: false,
    is_persistent: false,
    input_field_placeholder: 'Choose what you want to share'
  };
}

async function reply(chatId, text, extra = {}) {
  return api.sendMessage({ chat_id: chatId, text, ...extra });
}

async function saveResolverKey(apiKey) {
  const existing = await db.select({ id: resolverConfig.id }).from(resolverConfig).where(eq(resolverConfig.id, 1)).get();
  const updatedAt = Math.floor(Date.now() / 1000);
  if (existing) {
    await db.update(resolverConfig).set({ apiKey, updatedAt }).where(eq(resolverConfig.id, 1)).run();
  } else {
    await db.insert(resolverConfig).values({ id: 1, apiKey, updatedAt }).run();
  }
}

async function resolverRequest(path, payload) {
  const config = await db.select({ apiKey: resolverConfig.apiKey }).from(resolverConfig).where(eq(resolverConfig.id, 1)).get();
  if (!config?.apiKey) throw new Error('Resolver is not configured. Ask the owner to run /setresolver privately.');
  let response;
  try {
    response = await fetch(RESOLVER_BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('Resolver network request failed:', path, String(error?.message ?? error));
    throw new Error('Fetch failed: ' + String(error?.message ?? error).slice(0, 180));
  }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body.ok !== true) {
    const detail = typeof body.detail === 'string' ? body.detail : 'Resolver request failed.';
    console.warn('Resolver returned an error:', path, response.status, detail);
    throw new Error('Resolver HTTP ' + response.status + ': ' + detail);
  }
  return body;
}


async function setResolverCommand(message, text) {
  const chatId = message.chat.id;
  if (message.chat.type !== 'private' || String(message.from?.id ?? '') !== OWNER_ID) {
    await reply(chatId, '⛔ This setup command is available only to the bot owner in private chat.');
    return true;
  }
  const match = text.match(/^\/setresolver(?:@\w+)?\s+(\S{24,512})$/i);
  if (!match) {
    await reply(chatId, 'Usage: /setresolver YOUR_RENDER_RESOLVER_API_KEY\nSend this command only in the private chat with this bot.');
    return true;
  }
  try {
    await api.deleteMessage({ chat_id: chatId, message_id: message.message_id });
  } catch {
    await reply(chatId, '❌ Could not securely delete the setup message. Please try again in this private chat.');
    return true;
  }
  try {
    await saveResolverKey(match[1]);
    await reply(chatId, '✅ Resolver API key saved. The setup message was deleted.');
  } catch (error) {
    console.error('Resolver configuration save failed:', String(error?.message ?? 'unknown error'));
    await reply(chatId, '❌ Could not save resolver configuration. Please check the bot database and try again.');
  }
  return true;
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

function formatStatsText(value) {
  return String(value ?? '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^([^:]{2,40}:)\s*(.*)$/);
      return match
        ? '<b>' + esc(match[1]) + '</b> ' + esc(match[2])
        : esc(line);
    })
    .join('\n');
}

async function result(chatId, data) {
  await recordHistory(data);
  let statsText = null;
  let statsError = null;
  if (data.kind === 'User') {
    try {
      const stats = await resolverRequest('/v1/darkcams/stats', { user_id: String(data.id) });
      statsText = String(stats.stats_text ?? '').trim();
      if (!statsText) statsError = 'DARKC4MSHOW returned an empty Stats page.';
    } catch (error) {
      statsError = String(error?.message ?? 'DARKC4MSHOW request failed.');
      console.warn('DARKC4MSHOW Stats page unavailable:', statsError);
    }
  }

  const statsReady = Boolean(statsText);
  const lines = statsReady
    ? ['📊 <b>Account Statistics</b>', '', formatStatsText(statsText).slice(0, 3300)]
    : [
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
          : null,
        data.kind === 'User' && statsError
          ? '⚠️ Statistics are temporarily unavailable: ' + esc(statsError.slice(0, 260))
          : null
      ].filter(Boolean);

  const keyboard = [[{ text: '📋 Copy ID', copy_text: { text: String(data.id) } }]];
  // Show history controls only after a valid statistics page was captured.
  if (statsReady) {
    keyboard.push(
      [{
        text: '🔗 Username History',
        callback_data: 'darkcams:username:' + String(data.id),
        style: 'primary',
        icon_custom_emoji_id: '5807468998840814853'
      }],
      [{
        text: '📜 Name History',
        callback_data: 'darkcams:name:' + String(data.id),
        style: 'primary',
        icon_custom_emoji_id: '5807468998840814853'
      }]
    );
  }
  return reply(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendSearching(chatId) {
  try {
    return await reply(chatId, '<tg-emoji emoji-id="5267415876851744059">🔎</tg-emoji> Searching for result...', { parse_mode: 'HTML' });
  } catch (error) {
    console.warn('Could not send searching status:', String(error?.message ?? error));
    return null;
  }
}

async function finishSearching(statusMessage, chatId, data) {
  if (statusMessage?.message_id) {
    try {
      const finalMessage = await result(chatId, data);
      await api.deleteMessage({ chat_id: chatId, message_id: statusMessage.message_id });
      return finalMessage;
    } catch (error) {
      console.warn('Could not replace searching status:', String(error?.message ?? error));
    }
  }
  return result(chatId, data);
}

async function lookupChat(chatId, username, statusMessage = null) {
  try {
    const chat = await api.getChat({ chat_id: username });
    const kind = chat.type === 'channel' ? 'Channel' : chat.type === 'supergroup' ? 'Supergroup' : chat.type === 'group' ? 'Group' : 'Chat';
    await finishSearching(statusMessage, chatId, {
      kind,
      name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' '),
      username: chat.username,
      id: chat.id
    });
  } catch (error) {
    console.warn('Bot API username lookup failed; trying MTProto resolver:', username);
    try {
      const resolved = await resolverRequest('/v1/resolve', { username });
      const profile = resolved.result;
      await finishSearching(statusMessage, chatId, { kind: profile.kind, name: profile.name, username: profile.username, id: profile.id });
    } catch (resolverError) {
      console.warn('MTProto username lookup failed:', String(resolverError?.message ?? 'unknown error'));
      if (statusMessage?.message_id) { try { await api.deleteMessage({ chat_id: chatId, message_id: statusMessage.message_id }); } catch {} }
      await reply(chatId, '❌ Could not resolve ' + username + '. Resolver error: ' + String(resolverError?.message ?? 'unknown error').slice(0, 220));
    }
  }
}

async function lookupUserId(chatId, userId, statusMessage = null) {
  try {
    const resolved = await resolverRequest('/v1/resolve', { user_id: String(userId) });
    const profile = resolved.result;
    await finishSearching(statusMessage, chatId, { kind: profile.kind, name: profile.name, username: profile.username, id: profile.id });
  } catch (error) {
    console.warn('Numeric profile resolution unavailable; trying numeric ID fallback.');
    await finishSearching(statusMessage, chatId, { kind: 'User', name: null, username: null, id: String(userId) });
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
    const statusMessage = await sendSearching(message.chat.id);
    await finishSearching(statusMessage, message.chat.id, { kind: user.is_bot ? 'Bot' : 'User', name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username, id: user.id });
    return true;
  }
  if (origin.type === 'chat' && origin.sender_chat) {
    const chat = origin.sender_chat;
    const statusMessage = await sendSearching(message.chat.id);
    await finishSearching(statusMessage, message.chat.id, { kind: 'Group', name: chat.title, username: chat.username, id: chat.id });
    return true;
  }
  if (origin.type === 'channel' && origin.chat) {
    const chat = origin.chat;
    const statusMessage = await sendSearching(message.chat.id);
    await finishSearching(statusMessage, message.chat.id, { kind: 'Channel', name: chat.title, username: chat.username, id: chat.id });
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

  if (message.users_shared?.users?.length) {
    const statusMessage = await sendSearching(message.chat.id);
    for (const user of message.users_shared.users) {
      await finishSearching(statusMessage, message.chat.id, {
        kind: user.is_bot || message.users_shared.request_id === 8102 ? 'Bot' : 'User',
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Shared account',
        username: user.username,
        id: user.user_id
      });
    }
    return;
  }
  if (message.chat_shared?.chat_id) {
    const statusMessage = await sendSearching(message.chat.id);
    const chat = message.chat_shared;
    await finishSearching(statusMessage, message.chat.id, {
      kind: 'Group / Channel', name: chat.title || 'Shared chat',
      username: chat.username, id: chat.chat_id
    });
    return;
  }
  if (await emojiToId(message)) return;
  if (message.forward_origin) {
    const origin = message.forward_origin;
    const statusMessage = await sendSearching(message.chat.id);
    if (origin.type === 'user' && origin.sender_user) {
      const user = origin.sender_user;
      await finishSearching(statusMessage, message.chat.id, { kind: user.is_bot ? 'Bot' : 'User', name: [user.first_name, user.last_name].filter(Boolean).join(' '), username: user.username, id: user.id });
      return;
    }
    if (origin.type === 'chat' && origin.sender_chat) {
      const chat = origin.sender_chat;
      await finishSearching(statusMessage, message.chat.id, { kind: 'Group', name: chat.title, username: chat.username, id: chat.id });
      return;
    }
    if (origin.type === 'channel' && origin.chat) {
      const chat = origin.chat;
      await finishSearching(statusMessage, message.chat.id, { kind: 'Channel', name: chat.title, username: chat.username, id: chat.id });
      return;
    }
    if (origin.type === 'hidden_user') {
      if (statusMessage?.message_id) { try { await api.deleteMessage({ chat_id: message.chat.id, message_id: statusMessage.message_id }); } catch {} }
      await reply(message.chat.id, '⚠️ This forward hides the original sender. Telegram does not provide that user’s ID.');
      return;
    }
    if (statusMessage?.message_id) { try { await api.deleteMessage({ chat_id: message.chat.id, message_id: statusMessage.message_id }); } catch {} }
    return;
  }

  const text = String(message.text ?? '').trim();
  if (/^\/setresolver(?:@\w+)?(?:\s|$)/i.test(text)) {
    await setResolverCommand(message, text);
    return;
  }
  if (text === '/start' || text.startsWith('/start@') || text === '/help' || text.startsWith('/help@')) {
    try {
      await api.setMyCommands({
        commands: [
          { command: 'start', description: 'Start the bot' },
          { command: 'help', description: 'Show help' },
          { command: 'emojiid', description: 'Get a custom emoji ID' },
          { command: 'idemoji', description: 'Find a custom emoji by ID' }
        ]
      });
    } catch (error) {
      console.warn('Could not update bot commands', error);
    }
    await reply(message.chat.id, HELP, message.chat.type === 'private'
      ? { reply_markup: picker() }
      : {});
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
    const statusMessage = await sendSearching(message.chat.id);
    await lookupChat(message.chat.id, username, statusMessage);
    return;
  }
  if (/^[1-9][0-9]{0,19}$/.test(text)) {
    const statusMessage = await sendSearching(message.chat.id);
    await lookupUserId(message.chat.id, text, statusMessage);
    return;
  }

  if (text.startsWith('/')) {
    await reply(message.chat.id, 'Unknown command. Send /help for instructions.');
    return;
  }

  await reply(message.chat.id, 'Send a Telegram username, t.me link, numeric user ID, or use the share keyboard. Public usernames are resolved through Telegram Bot API and the MTProto resolver. User lookups show DARKC4MSHOW Stats and Name/Username History when available. For custom emoji, send a Premium custom emoji or use /idemoji <id>.');
}
