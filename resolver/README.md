# BikaIDChecker MTProto Resolver

A small, private-by-key HTTP service used by the Telegram Serverless bot to resolve public Telegram usernames through an authorized MTProto account session.

## Runtime

- Python 3.11+
- FastAPI + Telethon
- Render Web Service
- No Telegram bot token is required by this resolver.
- The MTProto account session is a highly sensitive credential. Anyone with it can act as that Telegram account.

## Endpoints

- `GET /healthz` — reports only whether the resolver is configured.
- `POST /v1/resolve` — requires `X-API-Key` and accepts exactly one of:
  - `{"username":"@publicusername"}`
  - `{"user_id":"123456789"}`

Successful responses include only public peer metadata needed by BikaIDChecker: ID, type, display name, username, and selected public flags. Phone numbers, access hashes, session data, and private profile fields are never returned.

## Required Render environment variables

Set these in Render → service → Environment. Never commit them or send them in a chat:

- `TELEGRAM_API_ID` — from https://my.telegram.org
- `TELEGRAM_API_HASH` — from https://my.telegram.org
- `TELEGRAM_SESSION` — Telethon StringSession generated locally from the intended Telegram account
- `RESOLVER_API_KEY` — a long random API key shared only with the Serverless bot configuration

Optional:

- `TELEGRAM_SESSION_PATH` — SQLite session path; defaults to `/tmp/bikaidchecker`
- `LOG_LEVEL` — defaults to `INFO`

## Local development

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r resolver/requirements-dev.txt
python resolver/generate_session.py  # run locally; keep output secret
uvicorn resolver.app:app --host 127.0.0.1 --port 8000
pytest -q resolver/test_resolver.py
```

## Render

- Runtime: Python
- Build: `pip install -r resolver/requirements.txt`
- Start: `uvicorn resolver.app:app --host 0.0.0.0 --port $PORT`
- Recommended region: Singapore for Thailand-based users.

The free Render instance may spin down after inactivity, causing cold-start delays. A paid always-on instance is required for consistently low latency. Render's ephemeral filesystem is not durable: the default Telethon SQLite peer cache is lost on restarts. Username resolution still works after restart; numeric-ID resolution may only work for peers known in the current session cache. Use a persistent disk or durable peer store if persistent ID cache is required.

## Telegram limitations

A username can be resolved when it is public and Telegram allows the account session to access it. A numeric ID alone is not globally searchable: Telegram requires the MTProto session to have encountered the peer and retained the corresponding access hash. A successful username lookup seeds that peer in the running session cache, but this cache is not guaranteed to survive a Render restart without persistent storage.
