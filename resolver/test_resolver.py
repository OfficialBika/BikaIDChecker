import pytest

import resolver.app as resolver


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
    assert resolver.normalize_username(value) == expected


@pytest.mark.parametrize("value", ["", "@ab", "https://evil.example/name", "t.me/joinchat/abc", "name with spaces"])
def test_reject_invalid_username(value):
    with pytest.raises(ValueError):
        resolver.normalize_username(value)


def test_user_profile_does_not_expose_private_fields(monkeypatch):
    class FakeUser:
        id = 123
        bot = False
        first_name = "Bika"
        last_name = "Helper"
        username = "bikahelper"
        verified = True
        premium = True
        scam = False
        fake = False
        phone = "123456789"
        access_hash = 987654321

    monkeypatch.setattr(resolver, "User", FakeUser)
    result = resolver.entity_profile(FakeUser())
    assert result["id"] == "123"
    assert result["name"] == "Bika Helper"
    assert result["username"] == "bikahelper"
    assert "phone" not in result
    assert "access_hash" not in result


def test_channel_profile(monkeypatch):
    class FakeChannel:
        id = 456
        broadcast = True
        title = "Bika News"
        username = "bikanews"
        verified = False
        scam = False
        fake = False
        access_hash = 987654321

    monkeypatch.setattr(resolver, "Channel", FakeChannel)
    result = resolver.entity_profile(FakeChannel())
    assert result["id"] == "456"
    assert result["kind"] == "Channel"
    assert result["username"] == "bikanews"
    assert "access_hash" not in result


def test_group_profile(monkeypatch):
    class FakeChat:
        id = 55
        title = "Bika Group"

    monkeypatch.setattr(resolver, "User", type("OtherUser", (), {}))
    monkeypatch.setattr(resolver, "Channel", type("OtherChannel", (), {}))
    monkeypatch.setattr(resolver, "Chat", FakeChat)
    result = resolver.entity_profile(FakeChat())
    assert result == {"id": "55", "kind": "Group", "name": "Bika Group", "username": None}
