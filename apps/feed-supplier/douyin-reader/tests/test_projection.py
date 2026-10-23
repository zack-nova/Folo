import unittest

from douyin_reader.projection import (
    ReaderError,
    check_status,
    collection_page,
    following_page,
    self_identity,
)


class ProjectionTest(unittest.TestCase):
    def test_follow_pages_carry_the_min_time_cursor(self) -> None:
        page = following_page(
            {
                "status_code": 0,
                "has_more": True,
                "min_time": 1760000000,
                "followings": [
                    {
                        "sec_uid": "MS4wLjABAAAA-one",
                        "uid": 1,
                        "nickname": "One",
                        "signature": "Bio",
                        "avatar_larger": {"url_list": ["https://p3.douyinpic.com/a.jpeg"]},
                        "follower_count": 10,
                        "aweme_count": 2,
                    },
                    {"uid": 2, "nickname": "No sec_uid"},
                ],
            }
        )
        self.assertEqual(page["cursor"], "1760000000")
        self.assertTrue(page["hasMore"])
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(page["items"][0]["avatar"], "https://p3.douyinpic.com/a.jpeg")
        self.assertEqual(page["items"][0]["uid"], "1")

    def test_the_last_page_has_no_cursor(self) -> None:
        page = collection_page({"status_code": 0, "has_more": False, "cursor": 99, "aweme_list": []})
        self.assertEqual(page, {"items": [], "hasMore": False, "cursor": None})

    def test_favorites_keep_only_the_fields_the_supplier_uses(self) -> None:
        page = collection_page(
            {
                "status_code": 0,
                "has_more": True,
                "cursor": 1700000000123,
                "aweme_list": [
                    {
                        "aweme_id": "7400000000000000001",
                        "aweme_type": 0,
                        "desc": "A video",
                        "create_time": 1700000000,
                        "author": {"nickname": "Maker", "sec_uid": "MS4w-maker", "uid": "9"},
                        "video": {"duration": 61000, "cover": {"url_list": ["https://cover"]}},
                        "statistics": {"digg_count": 5, "comment_count": 1, "collect_count": 2},
                        "music": {"title": "dropped"},
                    }
                ],
            }
        )
        self.assertEqual(page["cursor"], "1700000000123")
        item = page["items"][0]
        self.assertEqual(item["awemeId"], "7400000000000000001")
        self.assertEqual(item["cover"], "https://cover")
        self.assertEqual(item["shares"], 0)
        self.assertNotIn("music", item)

    def test_status_codes_map_to_reader_errors(self) -> None:
        for payload, status, code in [
            ({}, 429, "douyin_rejected"),
            ({"status_code": 8}, 401, "douyin_auth_invalid"),
            ({"status_code": 2096}, 403, "douyin_access_denied"),
            ({"status_code": 5}, 502, "douyin_platform_error"),
        ]:
            with self.assertRaises(ReaderError) as raised:
                check_status(payload, "follows")
            self.assertEqual((raised.exception.status, raised.exception.code), (status, code))

    def test_identity_needs_a_logged_in_profile(self) -> None:
        self.assertEqual(
            self_identity({"status_code": 0, "user": {"uid": 7, "sec_uid": "MS4w-me"}}), ("7", "MS4w-me")
        )
        with self.assertRaises(ReaderError):
            self_identity({"status_code": 0, "user": {"uid": 7}})


if __name__ == "__main__":
    unittest.main()
