from types import SimpleNamespace

import pytest
from telethon.tl.types import Channel, Chat, User

from resolver.app import entity_profile, normalize_username


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("@BikaHelper", "BikaHelper"),
        ("BikaHelper", "BikaHelper"),
        ("https://t.me/BikaHelper", "BikaHelper"),
        ("t.me/BikaHelper", "BikaHelper"),
    ],
)
def test_normalize_username(value, expected):
    assert normalize_username(value) == expected


@pytest.mark.parametrize("value", ["", "@ab", "https://evil.example/name", "t.me/joinchat/abc", "name with spaces"])
def test_reject_invalid_username(value):
    with pytest.raises(ValueError):
        normalize_username(value)


def test_user_profile_does_not_expose_private_fields():
    entity = User(
        id=123,
        is_self=False,
        contact=False,
        mutual_contact=False,
        deleted=False,
        bot=False,
        bot_chat_history=False,
        bot_nochats=False,
        verified=True,
        restricted=False,
        min=False,
        bot_inline_geo=False,
        support=False,
        scam=False,
        apply_min_photo=False,
        fake=False,
        bot_attach_menu=False,
        premium=True,
        attach_menu_enabled=False,
        bot_can_edit=False,
        close_friend=False,
        stories_hidden=False,
        stories_unavailable=False,
        contact_require_premium=False,
        bot_business=False,
        bot_has_main_app=False,
        bot_forum_view=False,
        bot_forum_can_create_topics=False,
        bot_forum_can_create_topics_for_users=False,
        first_name="Bika",
        last_name="Helper",
        username="bikahelper",
        phone="123456789",
        access_hash=987654321,
    )
    result = entity_profile(entity)
    assert result["id"] == "123"
    assert result["name"] == "Bika Helper"
    assert result["username"] == "bikahelper"
    assert "phone" not in result
    assert "access_hash" not in result


def test_channel_profile():
    entity = SimpleNamespace()
    channel = Channel(
        id=123,
        title="Bika News",
        photo=None,
        date=None,
        creator=False,
        left=False,
        broadcast=True,
        verified=False,
        megagroup=False,
        restricted=False,
        signatures=False,
        min=False,
        scam=False,
        has_link=False,
        has_geo=False,
        slowmode_enabled=False,
        call_active=False,
        call_not_empty=False,
        fake=False,
        gigagroup=False,
        noforwards=False,
        join_to_send=False,
        join_request=False,
        forum=False,
        stories_hidden=False,
        stories_hidden_min=False,
        stories_unavailable=False,
        signature_profiles=False,
        autotranslation=False,
        broadcast_messages_allowed=False,
        monoforum=False,
        forum_tabs=False,
        access_hash=987654321,
        username="bikanews",
    )
    result = entity_profile(channel)
    assert result["kind"] == "Channel"
    assert result["username"] == "bikanews"
    assert "access_hash" not in result


def test_group_profile():
    chat = Chat(
        id=55,
        title="Bika Group",
        photo=None,
        participants_count=2,
        date=None,
        version=1,
        creator=False,
        left=False,
        deactivated=False,
        call_active=False,
        call_not_empty=False,
        noforwards=False,
    )
    result = entity_profile(chat)
    assert result == {"id": "55", "kind": "Group", "name": "Bika Group", "username": None}
