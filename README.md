# BikaIDChecker

A proprietary Telegram Serverless bot for looking up Telegram IDs from information the Bot API is allowed to expose.

## Runtime
- Telegram Serverless official JavaScript runtime
- Built-in `sdk` module; no runtime npm dependencies
- No VPS, Render, or third-party webhook host
- No persistent user lookup history

## Lookup methods
1. Send a public supergroup/channel username (such as `@publicchannel` or `https://t.me/publicchannel`). The bot uses Bot API `getChat` and returns the numeric chat ID and available metadata.
2. In a private chat, use Telegram's share-user picker to share a user or bot ID.
3. Use the share-chat picker to share a group or channel ID.
4. Forward a message when Telegram includes a visible forward origin. Hidden-user forwards do not expose the original ID.

## Additional tools
- Account Created Date: approximate User ID-based estimate for private user accounts only. It is not an official Telegram timestamp.
- Emoji to ID: send a Telegram Premium custom emoji to read its `custom_emoji_id`.
- ID to Emoji: use `/idemoji <custom_emoji_id>` to retrieve the associated emoji and sticker-set name when available.
- Standard Unicode emoji do not have Telegram custom emoji IDs.

## Telegram API limitations
The Bot API does not provide a general username-to-ID resolver for arbitrary personal accounts or arbitrary bots. A typed username can resolve public supergroups/channels with `getChat`, but not arbitrary users or bots. Use the Telegram share picker or a message that exposes the sender.

Telegram does not expose account registration/creation timestamps in the Bot API. For private user accounts, the bot now estimates an approximate date by interpolating public User ID reference samples. The result is explicitly marked as an estimate, may be inaccurate, and is unavailable outside the sample range. Bots, groups, and channels are not assigned an account creation estimate.

Private chats/groups/channels can only be inspected when Telegram provides access and the user shares the chat or forwards an eligible message. An invite link alone does not reveal a numeric ID.

## Deploy
1. Enable Serverless for this bot in @BotFather → bot → Serverless.
2. Open CLI Access and obtain the Serverless CLI access token. This is separate from the Bot API token. Never commit either token.
3. On a computer with Node.js 18+, clone this repository and run:
   ```sh
   npm install
   npx tgcloud login
   npx tgcloud status
   npx tgcloud push
   ```
4. Test with `npx tgcloud run handlers/message '{ chat: { id: 1, type: "private" }, from: { id: 2, first_name: "Test" }, text: "/start" }'`.

No database migration is required; this bot does not persist user data.

## License and source access
All rights reserved. No permission is granted to use, copy, modify, redistribute, sublicense, publish, or create derivative works without prior written permission. See [LICENSE](LICENSE).

This is a proprietary notice, not an open-source license. A license notice cannot technically prevent copying or access to a public repository. Keep the GitHub repository private for stronger practical control over source access.
