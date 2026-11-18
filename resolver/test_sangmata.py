from types import SimpleNamespace

from resolver.sangmata import parse_sangmata_messages


def test_parse_sectioned_sangmata_history():
    result = parse_sangmata_messages([
        SimpleNamespace(message=(
            "Name History:\n"
            "1. Alice Example - 2024-01-02\n"
            "2. Alice Old - 2023-06-10\n"
            "\nUsername History:\n"
            "1. @alice_new - 2024-01-02\n"
            "2. @alice_old - 2023-06-10"
        ))
    ])
    assert result["names"] == ["Alice Example", "Alice Old"]
    assert result["usernames"] == ["@alice_new", "@alice_old"]
    assert result["message_count"] == 1
    assert "Alice Example" in result["raw_text"]


def test_parse_key_value_and_multi_message_history():
    result = parse_sangmata_messages([
        SimpleNamespace(message="Name: Bika User\nUsername: @bika_user"),
        SimpleNamespace(message="Previous username: @old_bika")
    ])
    assert result["names"] == ["Bika User"]
    assert result["usernames"] == ["@bika_user", "@old_bika"]
    assert result["message_count"] == 2


def test_empty_sangmata_response():
    result = parse_sangmata_messages([SimpleNamespace(message="  "), SimpleNamespace(message=None)])
    assert result["raw_text"] == ""
    assert result["names"] == []
    assert result["usernames"] == []
    assert result["message_count"] == 0
