import { api } from 'sdk';

const HELP = [
  '🔎 BikaIDChecker',
  '',
  '• Send a public group/channel @username or t.me link.',
  '• Use the share buttons to get a user, bot, group, or channel ID.',
  '• Forward a message to inspect its visible sender/origin.',
  '',
  'Account registration dates are not exposed by Telegram Bot API.',
  'Arbitrary user/bot usernames cannot be resolved by the Bot API.',
  '',
  '/start or /help — show this help'
].join('\n');

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function parsePublicUsername(input) {
  const value = String(input ?? '').trim();
  const link = value.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z0-9_]{5,})(?:[/?#].*)?$/i);
  if (link) return '@' + link[1];
  if (/^@[A-Za-z0-9_]{5,}$/.test(value)) return value;
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
    is_persistent: true,
    input_field_placeholder: 'Send @username or choose a share button'
  };
}

async function reply(chatId, text, extra = {}) {
  return api.sendMessage({ chat_id: chatId, text, ...extra });
}

function privatePicker(message) {
  return message.chat.type === 'private' ? { reply_markup: picker() } : {};
}

async function result(chatId, data) {
  const lines = [
    '🔎 <b>Telegram ID Information</b>',
    '',
    '<b>Type:</b> ' + esc(data.kind),
    '<b>Name:</b> ' + esc(data.name || 'Not provided'),
    data.username ? '<b>Username:</b> ' + esc(data.username.startsWith('@') ? data.username : '@' + data.username) : null,
    '<b>ID:</b> <code>' + esc(data.id) + '</code>',
    '<b>Account created:</b> Not available from Telegram Bot API'
  ].filter(Boolean);

  return reply(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📋 Copy ID', copy_text: { text: String(data.id) } }]] }
  });
}

async function lookupChat(chatId, username) {
  try {
    const chat = await api.getChat({ chat_id: username });
    const kind = chat.type === 'channel' ? 'Channel' : chat.type === 'supergroup' ? 'Supergroup' : chat.type === 'group' ? 'Group' : 'Chat';
  } catch {
    await reply(chatId, '❌ Username could not be resolved. Bot API getChat resolves public groups/supergroups/channels, not arbitrary personal users or bots. Use the share buttons in a private chat or forward a message with a visible sender.');
  }
}

async function sharedUsers(message) {
  const shared = message.users_shared;
  const users = shared?.users;
  if (!Array.isArray(users) || users.length === 0) return false;
  for (const user of users) {
    await result(message.chat.id, {
      kind: shared.request_id === 8102 ? 'Bot' : 'User',
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

export default async function (message) {
  if (!message?.chat?.id) return;

  if (await sharedUsers(message)) return;
  if (await sharedChat(message)) return;
  if (await forwarded(message)) return;

  const text = String(message.text ?? '').trim();
  if (text === '/start' || text.startsWith('/start@') || text === '/help' || text.startsWith('/help@')) {
    await reply(message.chat.id, HELP, privatePicker(message));
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

  await reply(message.chat.id, 'Send a public group/channel @username or t.me link. For users and bots, use the share buttons in a private chat or forward a message with a visible sender.', privatePicker(message));
}
