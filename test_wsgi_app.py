import base64
import gc
import io
import json
import os
import sqlite3
import tempfile
import unittest
from http.cookies import SimpleCookie
from unittest.mock import patch
from wsgiref.validate import validator


_database_directory = tempfile.TemporaryDirectory(prefix="murmur-wsgi-test-")
os.environ["MURMUR_DATA_DIR"] = _database_directory.name

import wsgi_app

_validated_application = validator(wsgi_app.application)

def tearDownModule():
    gc.collect()
    _database_directory.cleanup()


class WsgiApplicationTests(unittest.TestCase):
    def request(self, path, method="GET", body=b"", headers=None):
        headers = headers or {}
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "QUERY_STRING": "",
            "SERVER_NAME": "murmur.pythonanywhere.com",
            "SERVER_PORT": "443",
            "HTTP_HOST": "murmur.pythonanywhere.com",
            "SCRIPT_NAME": "",
            "wsgi.version": (1, 0),
            "wsgi.url_scheme": "https",
            "wsgi.errors": io.StringIO(),
            "wsgi.multithread": True,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
            "wsgi.input": io.BytesIO(body),
        }
        environ.update(headers)
        result = {}

        def start_response(status, response_headers):
            result["status"] = status
            result["headers"] = dict(response_headers)

        response = _validated_application(environ, start_response)
        try:
            result["body"] = b"".join(response)
        finally:
            response.close()
        return result

    def post_json(self, path, payload, cookie=None):
        body = json.dumps(payload).encode()
        headers = {
            "CONTENT_TYPE": "application/json",
            "CONTENT_LENGTH": str(len(body)),
            "HTTP_ORIGIN": "https://murmur.pythonanywhere.com",
        }
        if cookie:
            headers["HTTP_COOKIE"] = cookie
        return self.request(path, method="POST", body=body, headers=headers)

    def signup(self, username):
        response = self.post_json(
            "/api/signup",
            {"username": username, "password": "test-password"},
        )
        self.assertTrue(response["status"].startswith("201 "))
        cookie = SimpleCookie()
        cookie.load(response["headers"]["Set-Cookie"])
        return f"pwa_session={cookie['pwa_session'].value}"

    def test_serves_inbox_and_reports_unknown_files(self):
        response = self.request("/")
        self.assertTrue(response["status"].startswith("200 "))
        self.assertIn(b"Murmur", response["body"])
        self.assertEqual(response["headers"]["Cache-Control"], "no-cache")

        missing = self.request("/not-a-public-file")
        self.assertTrue(missing["status"].startswith("404 "))

    def test_signup_sets_secure_session_and_session_endpoint_reads_it(self):
        body = json.dumps({"username": "pythonanywhere", "password": "test-password"}).encode()
        signup = self.request(
            "/api/signup",
            method="POST",
            body=body,
            headers={
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(body)),
                "HTTP_ORIGIN": "https://murmur.pythonanywhere.com",
            },
        )
        self.assertTrue(signup["status"].startswith("201 "))
        cookie = SimpleCookie()
        cookie.load(signup["headers"]["Set-Cookie"])
        self.assertTrue(cookie["pwa_session"]["secure"])
        self.assertTrue(cookie["pwa_session"]["httponly"])

        session_cookie = f"pwa_session={cookie['pwa_session'].value}"
        session = self.request("/api/me", headers={"HTTP_COOKIE": session_cookie})
        self.assertTrue(session["status"].startswith("200 "))
        self.assertEqual(json.loads(session["body"])["user"]["username"], "pythonanywhere")

    def test_push_subscription_sends_message_alert_and_can_be_removed(self):
        env_names = (
            "MURMUR_VAPID_PUBLIC_KEY",
            "MURMUR_VAPID_PRIVATE_KEY",
            "MURMUR_VAPID_SUBJECT",
        )
        original_environment = {name: os.environ.get(name) for name in env_names}
        os.environ["MURMUR_VAPID_PUBLIC_KEY"] = "test-public-key"
        os.environ["MURMUR_VAPID_PRIVATE_KEY"] = "test-private-key"
        os.environ["MURMUR_VAPID_SUBJECT"] = "mailto:test@example.com"
        try:
            sender_cookie = self.signup("pushsender")
            recipient_cookie = self.signup("pushrecipient")
            conversation_response = self.post_json(
                "/api/conversations",
                {"username": "pushrecipient"},
                sender_cookie,
            )
            self.assertTrue(conversation_response["status"].startswith("200 "))
            conversation_id = json.loads(conversation_response["body"])["conversation_id"]

            endpoint = "https://fcm.googleapis.com/fcm/send/test-endpoint"
            invalid_subscription = self.post_json(
                "/api/me/push-subscriptions",
                {"endpoint": "https://127.0.0.1:443/private", "keys": {}},
                recipient_cookie,
            )
            self.assertTrue(invalid_subscription["status"].startswith("400 "))
            subscription = {
                "endpoint": endpoint,
                "keys": {
                    "p256dh": base64.urlsafe_b64encode(bytes(range(65))).rstrip(b"=").decode(),
                    "auth": base64.urlsafe_b64encode(bytes(range(16))).rstrip(b"=").decode(),
                },
            }
            saved_subscription = self.post_json(
                "/api/me/push-subscriptions",
                subscription,
                recipient_cookie,
            )
            self.assertTrue(saved_subscription["status"].startswith("200 "))

            with patch("pywebpush.webpush") as send_push:
                sent_message = self.post_json(
                    f"/api/conversations/{conversation_id}/messages",
                    {"body": "Hello from a test"},
                    sender_cookie,
                )
            self.assertTrue(sent_message["status"].startswith("201 "))
            send_push.assert_called_once()
            push_payload = json.loads(send_push.call_args.kwargs["data"])
            self.assertEqual(push_payload["title"], "New message from pushsender")
            self.assertEqual(push_payload["body"], "You received a new message.")
            self.assertEqual(
                push_payload["url"],
                f"./conversation.html?conversation={conversation_id}",
            )

            removed_subscription = self.post_json(
                "/api/me/push-subscriptions",
                {"endpoint": endpoint, "enabled": False},
                recipient_cookie,
            )
            self.assertTrue(removed_subscription["status"].startswith("200 "))
            with sqlite3.connect(wsgi_app.murmur.DATABASE_PATH) as connection:
                count = connection.execute(
                    "SELECT COUNT(*) FROM push_subscriptions WHERE endpoint = ?",
                    (endpoint,),
                ).fetchone()[0]
            self.assertEqual(count, 0)
        finally:
            for name, value in original_environment.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
