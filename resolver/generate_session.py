"""Generate a Telethon StringSession locally; never upload or commit the output."""
from getpass import getpass

from telethon.sessions import StringSession
from telethon.sync import TelegramClient


def main() -> None:
    api_id = int(input("Telegram API ID: ").strip())
    api_hash = getpass("Telegram API Hash (hidden): ").strip()
    phone = input("Telegram phone number (international format): ").strip()

    with TelegramClient(StringSession(), api_id, api_hash) as client:
        client.start(
            phone=phone,
            code_callback=lambda: getpass("Telegram login code: ").strip(),
            password=lambda: getpass("Telegram 2-step verification password: "),
        )
        print("\nCopy this StringSession directly into Render's TELEGRAM_SESSION secret.")
        print("Do not send it in Telegram chats, commit it, or share it.\n")
        print(client.session.save())


if __name__ == "__main__":
    main()
