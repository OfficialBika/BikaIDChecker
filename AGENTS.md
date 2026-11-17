# BikaIDChecker contributor instructions

- This is a Telegram Serverless project. Runtime modules live only under `tgcloud/`.
- Use the built-in `sdk` module; do not add runtime npm dependencies.
- Keep work on the existing `main` branch unless the owner explicitly requests otherwise.
- Never commit Bot API tokens, Telegram Serverless CLI credentials, session strings, or personal data.
- Do not claim arbitrary user/bot usernames can be resolved through the Bot API.
- Do not infer account creation dates from Telegram IDs. The Bot API does not expose registration timestamps.
- Persistent old-name/old-username history is approved for this feature only. Store only distinct values observed by the bot, retain at most the current value plus ten previous values per field, and do not add unrelated analytics.
- Preserve the proprietary All Rights Reserved notice.
