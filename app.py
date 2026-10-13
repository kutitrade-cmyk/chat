import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import string
import tempfile
from http.cookies import CookieError, SimpleCookie
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


APP_DIR = Path(__file__).resolve().parent
DATABASE_DIR = Path(
    os.environ.get("MURMUR_DATA_DIR", APP_DIR / "data")
).expanduser().resolve()
DATABASE_PATH = DATABASE_DIR / "chat.sqlite3"
MAX_MESSAGE_LENGTH = 2000
MIN_USERNAME_LENGTH = 3
MAX_USERNAME_LENGTH = 30
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 1024
MAX_MESSAGES_PER_REQUEST = 100
DEFAULT_MESSAGES_PER_REQUEST = 50
MAX_REQUEST_BODY = 16384
MAX_PUSH_ENDPOINT_LENGTH = 2048
MAX_IMAGE_UPLOAD_BYTES = 200 * 1024 * 1024
IMAGE_TYPES = {
    "image/jpeg": (b"\xff\xd8\xff", ".jpg"),
    "image/png": (b"\x89PNG\r\n\x1a\n", ".png"),
    "image/webp": (b"RIFF", ".webp"),
}
PASSWORD_HASH_ITERATIONS = 310_000
SESSION_LIFETIME_SECONDS = 14 * 24 * 60 * 60
USERNAME_CHARACTERS = frozenset(string.ascii_letters + string.digits + "_.-")
BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
PUBLIC_FILES = {
    "app.js",
    "auth.js",
    "conversation.html",
    "conversation.js",
    "inbox.js",
    "index.html",
    "login.html",
    "manifest.webmanifest",
    "profile.html",
    "profile.js",
    "register.html",
    "styles.css",
    "sw.js",
}
PUBLIC_ICON_FILES = {
    "icon-192.png",
    "icon-512.png",
    "icon.svg",
}


def initialize_database():
    DATABASE_DIR.mkdir(exist_ok=True)
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT NOT NULL,
                client_id TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                user_id INTEGER REFERENCES users(id),
                image_file TEXT,
                image_mime TEXT
            )
            """
        )
        message_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(messages)")
        }
        if "user_id" not in message_columns:
            connection.execute(
                "ALTER TABLE messages ADD COLUMN user_id INTEGER REFERENCES users(id)"
            )
        if "image_file" not in message_columns:
            connection.execute("ALTER TABLE messages ADD COLUMN image_file TEXT")
        if "image_mime" not in message_columns:
            connection.execute("ALTER TABLE messages ADD COLUMN image_mime TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                username_normalized TEXT NOT NULL UNIQUE,
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                created_at TEXT NOT NULL,
                avatar_file TEXT,
                avatar_mime TEXT
            )
            """
        )
        user_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(users)")
        }
        if "avatar_file" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN avatar_file TEXT")
        if "avatar_mime" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN avatar_mime TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash BLOB PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_type TEXT NOT NULL CHECK (conversation_type = 'direct'),
                direct_key TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS conversation_members (
                conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                joined_at TEXT NOT NULL,
                last_read_message_id INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (conversation_id, user_id)
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members(user_id, conversation_id)"
        )
        message_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(messages)")
        }
        if "conversation_id" not in message_columns:
            connection.execute(
                "ALTER TABLE messages ADD COLUMN conversation_id INTEGER REFERENCES conversations(id)"
            )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, id)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                endpoint TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id)"
        )


def serialize_message(row):
    message = {
        "id": row[0],
        "sender": row[1],
        "body": row[2],
        "created_at": row[3],
        "user_id": row[4],
    }
    if len(row) > 5:
        message["read_by_recipient"] = row[5] >= row[0]
    if len(row) > 6 and row[6]:
        message["image_mime"] = row[6]
    return message


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_HASH_ITERATIONS,
    )


def normalized_username(username):
    if not isinstance(username, str):
        return None
    candidate = username.strip()
    if not MIN_USERNAME_LENGTH <= len(candidate) <= MAX_USERNAME_LENGTH:
        return None
    if any(character not in USERNAME_CHARACTERS for character in candidate):
        return None
    return candidate.lower()


def serialize_conversation(row):
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "username": row["username"],
        "has_avatar": bool(row["has_avatar"]),
        "last_message": row["last_message"],
        "last_message_at": row["last_message_at"],
        "unread_count": row["unread_count"],
    }


class PwaRequestHandler(BaseHTTPRequestHandler):
    server_version = "MyPwa/1.0"

    def do_GET(self):
        request = urlsplit(self.path)
        if request.path == "/api/me":
            user = self.get_authenticated_user()
            if user is not False:
                self.send_json(200, {"user": self.public_user(user) if user else None})
            return
        if request.path == "/api/me/push-config":
            user = self.require_authenticated_user()
            if user is not None:
                self.get_push_configuration(user)
            return
        if request.path == "/api/messages":
            user = self.require_authenticated_user()
            if user is not None:
                self.send_json(404, {"error": "Chat messages require a conversation."})
            return
        if request.path == "/api/users":
            user = self.require_authenticated_user()
            if user is not None:
                self.search_users(parse_qs(request.query), user)
            return
        user_profile_route = self.user_profile_route(request.path)
        if user_profile_route:
            user = self.require_authenticated_user()
            if user is not None:
                user_id, action = user_profile_route
                if action == "profile":
                    self.get_user_profile(user_id, user)
                else:
                    self.get_user_avatar(user_id, user)
            return
        if request.path == "/api/conversations":
            user = self.require_authenticated_user()
            if user is not None:
                self.get_conversations(user)
            return
        conversation_image_route = self.conversation_image_route(request.path)
        if conversation_image_route:
            user = self.require_authenticated_user()
            if user is not None:
                conversation_id, message_id = conversation_image_route
                self.get_conversation_image(conversation_id, message_id, user)
            return
        if request.path == "/api/updates":
            user = self.require_authenticated_user()
            if user is not None:
                self.get_updates(parse_qs(request.query), user)
            return
        conversation_route = self.conversation_route(request.path)
        if conversation_route:
            user = self.require_authenticated_user()
            if user is None:
                return
            conversation_id, action = conversation_route
            if action == "messages":
                self.get_conversation_messages(
                    conversation_id,
                    parse_qs(request.query),
                    user,
                )
            elif action == "read":
                self.send_json(405, {"error": "Use POST to mark messages as read."})
            else:
                self.send_json(404, {"error": "Not found."})
            return
        self.serve_static_file(request.path)

    @staticmethod
    def conversation_route(path):
        segments = path.strip("/").split("/")
        if (
            len(segments) == 4
            and segments[0] == "api"
            and segments[1] == "conversations"
            and segments[2].isdigit()
            and segments[3] in ("messages", "read")
        ):
            return int(segments[2]), segments[3]
        return None

    @staticmethod
    def conversation_image_route(path):
        segments = path.strip("/").split("/")
        if (
            len(segments) == 5
            and segments[0] == "api"
            and segments[1] == "conversations"
            and segments[2].isdigit()
            and segments[3] == "images"
            and segments[4].isdigit()
        ):
            return int(segments[2]), int(segments[4])
        return None

    @staticmethod
    def conversation_upload_route(path):
        segments = path.strip("/").split("/")
        if (
            len(segments) == 4
            and segments[0] == "api"
            and segments[1] == "conversations"
            and segments[2].isdigit()
            and segments[3] == "images"
        ):
            return int(segments[2])
        return None

    @staticmethod
    def user_profile_route(path):
        segments = path.strip("/").split("/")
        if (
            len(segments) == 4
            and segments[0] == "api"
            and segments[1] == "users"
            and segments[2].isdigit()
            and segments[3] in ("profile", "avatar")
        ):
            return int(segments[2]), segments[3]
        return None

    @staticmethod
    def public_user(user):
        return {
            "id": user["id"],
            "username": user["username"],
            "has_avatar": bool(user["avatar_file"]) if "avatar_file" in user.keys() else False,
        }

    def get_authenticated_user(self):
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except CookieError:
            return None
        session_cookie = cookie.get("pwa_session")
        if session_cookie is None or not session_cookie.value:
            return None
        token_hash = hashlib.sha256(session_cookie.value.encode("ascii", "ignore")).digest()
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.row_factory = sqlite3.Row
                user = connection.execute(
                    """
                    SELECT users.id, users.username, users.avatar_file
                    FROM auth_sessions
                    JOIN users ON users.id = auth_sessions.user_id
                    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
                    """,
                    (token_hash, now),
                ).fetchone()
            return dict(user) if user else None
        except sqlite3.Error:
            self.log_error("Could not validate the account session.")
            self.send_json(500, {"error": "Account sign-in is temporarily unavailable."})
            return False

    def require_authenticated_user(self):
        user = self.get_authenticated_user()
        if user is False:
            return None
        if user is None:
            self.send_json(401, {"error": "Please sign in to use chat."})
            return None
        return user

    @staticmethod
    def push_configuration():
        public_key = os.environ.get("MURMUR_VAPID_PUBLIC_KEY", "").strip()
        private_key = os.environ.get("MURMUR_VAPID_PRIVATE_KEY", "").strip()
        subject = os.environ.get("MURMUR_VAPID_SUBJECT", "").strip()
        return {
            "enabled": bool(public_key and private_key and subject),
            "public_key": public_key,
            "private_key": private_key,
            "subject": subject,
        }

    def get_push_configuration(self, user):
        configuration = self.push_configuration()
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                subscribed = connection.execute(
                    "SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1",
                    (user["id"],),
                ).fetchone() is not None
            self.send_json(
                200,
                {
                    "enabled": configuration["enabled"],
                    "public_key": configuration["public_key"] if configuration["enabled"] else None,
                    "subscribed": subscribed,
                },
            )
        except sqlite3.Error:
            self.log_error("Could not load push notification settings.")
            self.send_json(500, {"error": "Push notification settings are temporarily unavailable."})

    @staticmethod
    def is_valid_push_endpoint(endpoint):
        if not isinstance(endpoint, str) or len(endpoint) > MAX_PUSH_ENDPOINT_LENGTH:
            return False
        try:
            parsed = urlsplit(endpoint)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            return False
        if (
            parsed.scheme != "https"
            or not hostname
            or port not in (None, 443)
            or parsed.username
            or parsed.password
        ):
            return False
        hostname = hostname.lower().rstrip(".")
        allowed_hosts = (
            "fcm.googleapis.com",
            "push.services.mozilla.com",
            "notify.windows.com",
            "push.apple.com",
        )
        return any(
            hostname == allowed_host or hostname.endswith("." + allowed_host)
            for allowed_host in allowed_hosts
        )

    @staticmethod
    def is_valid_subscription_key(value, expected_length):
        if not isinstance(value, str) or len(value) > 128 or not BASE64URL_PATTERN.fullmatch(value):
            return False
        try:
            decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        except (ValueError, base64.binascii.Error):
            return False
        return len(decoded) == expected_length

    def save_push_subscription(self, payload, user):
        endpoint = payload.get("endpoint")
        if not self.is_valid_push_endpoint(endpoint):
            self.send_json(400, {"error": "The push service endpoint is invalid or unsupported."})
            return

        if payload.get("enabled") is False:
            try:
                with sqlite3.connect(DATABASE_PATH) as connection:
                    connection.execute(
                        "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
                        (endpoint, user["id"]),
                    )
                self.send_json(200, {"ok": True})
            except sqlite3.Error:
                self.log_error("Could not remove the push notification subscription.")
                self.send_json(500, {"error": "Could not turn off push notifications."})
            return

        keys = payload.get("keys")
        if not isinstance(keys, dict):
            self.send_json(400, {"error": "The push subscription keys are invalid."})
            return
        p256dh = keys.get("p256dh")
        auth = keys.get("auth")
        if not self.is_valid_subscription_key(p256dh, 65) or not self.is_valid_subscription_key(auth, 16):
            self.send_json(400, {"error": "The push subscription keys are invalid."})
            return

        configuration = self.push_configuration()
        if not configuration["enabled"]:
            self.send_json(503, {"error": "Push notifications are not configured on this server."})
            return

        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.execute(
                    """
                    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(endpoint) DO UPDATE SET
                        user_id = excluded.user_id,
                        p256dh = excluded.p256dh,
                        auth = excluded.auth,
                        created_at = excluded.created_at
                    """,
                    (endpoint, user["id"], p256dh, auth, created_at),
                )
            self.send_json(200, {"ok": True})
        except sqlite3.Error:
            self.log_error("Could not save the push notification subscription.")
            self.send_json(500, {"error": "Could not enable push notifications."})

    def send_push_notifications(self, conversation_id, sender, message_id):
        configuration = self.push_configuration()
        if not configuration["enabled"]:
            return

        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                subscriptions = connection.execute(
                    """
                    SELECT subscriptions.endpoint, subscriptions.p256dh, subscriptions.auth
                    FROM push_subscriptions AS subscriptions
                    JOIN conversation_members AS members
                        ON members.user_id = subscriptions.user_id
                    WHERE members.conversation_id = ? AND members.user_id != ?
                    """,
                    (conversation_id, sender["id"]),
                ).fetchall()
        except sqlite3.Error:
            self.log_error("Could not load push notification recipients.")
            return

        if not subscriptions:
            return

        from pywebpush import WebPushException, webpush

        payload = json.dumps(
            {
                "title": f"New message from {sender['username']}",
                "body": "You received a new message.",
                "url": f"./conversation.html?conversation={conversation_id}",
                "tag": f"chat-message-{message_id}",
            }
        )
        for endpoint, p256dh, auth in subscriptions:
            subscription = {
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            }
            try:
                webpush(
                    subscription_info=subscription,
                    data=payload,
                    vapid_private_key=configuration["private_key"],
                    vapid_claims={"sub": configuration["subject"]},
                    timeout=5,
                    ttl=86400,
                )
            except WebPushException as error:
                response = getattr(error, "response", None)
                status_code = getattr(response, "status_code", None)
                if status_code in (404, 410):
                    try:
                        with sqlite3.connect(DATABASE_PATH) as connection:
                            connection.execute(
                                "DELETE FROM push_subscriptions WHERE endpoint = ?",
                                (endpoint,),
                            )
                    except sqlite3.Error:
                        self.log_error("Could not remove an expired push subscription.")
                else:
                    self.log_error(
                        "Push notification delivery failed"
                        + (f" with status {status_code}." if status_code else ".")
                    )
            except (OSError, ValueError):
                self.log_error("Push notification delivery failed because of a network or configuration error.")

    def validate_same_origin(self):
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_json(403, {"error": "Cross-site requests are not allowed."})
            return False

        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self.send_json(403, {"error": "Requests must come from this app."})
            return False
        return True

    def read_json_payload(self):
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Send this request as JSON."})
            return None

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid request size."})
            return None
        if not 1 <= content_length <= MAX_REQUEST_BODY:
            self.send_json(413, {"error": "The request is too large."})
            return None

        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Send valid JSON."})
            return None
        if not isinstance(payload, dict):
            self.send_json(400, {"error": "Send a JSON object."})
            return None
        return payload

    def set_session_cookie(self, token):
        cookie = SimpleCookie()
        cookie["pwa_session"] = token
        cookie["pwa_session"]["path"] = "/"
        cookie["pwa_session"]["httponly"] = True
        cookie["pwa_session"]["samesite"] = "Strict"
        cookie["pwa_session"]["max-age"] = SESSION_LIFETIME_SECONDS
        if getattr(self.server, "secure_cookies", False):
            cookie["pwa_session"]["secure"] = True
        self._session_cookie_header = cookie.output(header="").strip()

    def clear_session_cookie(self):
        cookie = SimpleCookie()
        cookie["pwa_session"] = ""
        cookie["pwa_session"]["path"] = "/"
        cookie["pwa_session"]["httponly"] = True
        cookie["pwa_session"]["samesite"] = "Strict"
        cookie["pwa_session"]["max-age"] = 0
        if getattr(self.server, "secure_cookies", False):
            cookie["pwa_session"]["secure"] = True
        self._session_cookie_header = cookie.output(header="").strip()

    def send_json(self, status, payload):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        if hasattr(self, "_session_cookie_header"):
            self.send_header("Set-Cookie", self._session_cookie_header)
            del self._session_cookie_header
        self.end_headers()
        self.wfile.write(encoded)

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).digest()
        now = datetime.now(timezone.utc)
        expires_at = now.timestamp() + SESSION_LIFETIME_SECONDS
        expiry = datetime.fromtimestamp(expires_at, timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        with sqlite3.connect(DATABASE_PATH) as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE expires_at <= ?",
                (now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),),
            )
            connection.execute(
                "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user_id, expiry),
            )
        self.set_session_cookie(token)

    def handle_signup(self, payload):
        username = payload.get("username")
        password = payload.get("password")
        normalized = normalized_username(username)
        if normalized is None:
            self.send_json(
                400,
                {"error": "Username must be 3–30 characters: letters, numbers, dots, dashes, or underscores."},
            )
            return
        if (
            not isinstance(password, str)
            or len(password) < MIN_PASSWORD_LENGTH
            or len(password) > MAX_PASSWORD_LENGTH
        ):
            self.send_json(
                400,
                {"error": f"Password must be between {MIN_PASSWORD_LENGTH} and {MAX_PASSWORD_LENGTH} characters."},
            )
            return

        salt = secrets.token_bytes(16)
        password_hash = hash_password(password, salt)
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                cursor = connection.execute(
                    """
                    INSERT INTO users
                        (username, username_normalized, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (username.strip(), normalized, salt, password_hash, created_at),
                )
                user_id = cursor.lastrowid
            self.create_session(user_id)
            self.send_json(
                201,
                {"user": {"id": user_id, "username": username.strip()}},
            )
        except sqlite3.IntegrityError:
            self.send_json(409, {"error": "That username is already taken."})
        except sqlite3.Error:
            self.log_error("Could not create account.")
            self.send_json(500, {"error": "The account could not be created. Please try again."})

    def handle_login(self, payload):
        username = payload.get("username")
        password = payload.get("password")
        normalized = normalized_username(username)
        if normalized is None or not isinstance(password, str) or len(password) > MAX_PASSWORD_LENGTH:
            self.send_json(400, {"error": "Enter a valid username and password."})
            return

        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.row_factory = sqlite3.Row
                user = connection.execute(
                    """
                    SELECT id, username, password_salt, password_hash
                    FROM users WHERE username_normalized = ?
                    """,
                    (normalized,),
                ).fetchone()
            if user is None or not secrets.compare_digest(
                hash_password(password, user["password_salt"]),
                user["password_hash"],
            ):
                self.send_json(401, {"error": "Username or password is incorrect."})
                return

            self.create_session(user["id"])
            self.send_json(
                200,
                {"user": {"id": user["id"], "username": user["username"]}},
            )
        except sqlite3.Error:
            self.log_error("Could not sign in.")
            self.send_json(500, {"error": "Sign-in is temporarily unavailable. Please try again."})

    def handle_logout(self):
        cookie_header = self.headers.get("Cookie")
        if cookie_header:
            cookie = SimpleCookie()
            try:
                cookie.load(cookie_header)
                session_cookie = cookie.get("pwa_session")
            except CookieError:
                session_cookie = None
            if session_cookie and session_cookie.value:
                token_hash = hashlib.sha256(
                    session_cookie.value.encode("ascii", "ignore")
                ).digest()
                try:
                    with sqlite3.connect(DATABASE_PATH) as connection:
                        connection.execute(
                            "DELETE FROM auth_sessions WHERE token_hash = ?",
                            (token_hash,),
                        )
                except sqlite3.Error:
                    self.log_error("Could not revoke the account session.")
                    self.send_json(500, {"error": "Could not sign out. Please try again."})
                    return
        self.clear_session_cookie()
        self.send_json(200, {"ok": True})

    def create_conversation(self, payload, user):
        normalized = normalized_username(payload.get("username"))
        if normalized is None:
            self.send_json(400, {"error": "Enter a valid username to start a chat."})
            return
        if normalized == user["username"].lower():
            self.send_json(400, {"error": "You cannot start a chat with yourself."})
            return

        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.row_factory = sqlite3.Row
                recipient = connection.execute(
                    "SELECT id, username, avatar_file FROM users WHERE username_normalized = ?",
                    (normalized,),
                ).fetchone()
                if recipient is None:
                    self.send_json(404, {"error": "No account was found with that username."})
                    return

                first_user_id, second_user_id = sorted((user["id"], recipient["id"]))
                direct_key = f"{first_user_id}:{second_user_id}"
                connection.execute("BEGIN IMMEDIATE")
                conversation = connection.execute(
                    "SELECT id FROM conversations WHERE direct_key = ?",
                    (direct_key,),
                ).fetchone()
                if conversation is None:
                    cursor = connection.execute(
                        """
                        INSERT INTO conversations (conversation_type, direct_key, created_at)
                        VALUES ('direct', ?, ?)
                        """,
                        (direct_key, now),
                    )
                    conversation_id = cursor.lastrowid
                    connection.executemany(
                        """
                        INSERT INTO conversation_members (conversation_id, user_id, joined_at)
                        VALUES (?, ?, ?)
                        """,
                        (
                            (conversation_id, first_user_id, now),
                            (conversation_id, second_user_id, now),
                        ),
                    )
                else:
                    conversation_id = conversation["id"]
                connection.commit()
            self.send_json(
                200,
                {
                    "conversation_id": conversation_id,
                    "user": self.public_user(recipient),
                },
            )
        except sqlite3.Error:
            self.log_error("Could not create or open a direct conversation.")
            self.send_json(500, {"error": "Could not start that chat. Please try again."})

    def mark_conversation_read(self, conversation_id, payload, user):
        if not self.require_conversation_membership(conversation_id, user):
            return
        message_id = payload.get("message_id")
        if (
            not isinstance(message_id, int)
            or isinstance(message_id, bool)
            or message_id < 0
        ):
            self.send_json(400, {"error": "A valid last-read message ID is required."})
            return
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                conversation_message = connection.execute(
                    """
                    SELECT MAX(id) FROM messages
                    WHERE conversation_id = ? AND id <= ?
                    """,
                    (conversation_id, message_id),
                ).fetchone()[0]
                last_read_message_id = conversation_message or 0
                connection.execute(
                    """
                    UPDATE conversation_members
                    SET last_read_message_id = MAX(last_read_message_id, ?)
                    WHERE conversation_id = ? AND user_id = ?
                    """,
                    (last_read_message_id, conversation_id, user["id"]),
                )
            self.send_json(200, {"last_read_message_id": last_read_message_id})
        except sqlite3.Error:
            self.log_error("Could not update conversation read position.")
            self.send_json(500, {"error": "Could not mark messages as read."})

    def search_users(self, query, user):
        try:
            search = self.single_query_value(query, "search")
            if not isinstance(search, str) or len(search.strip()) < 2:
                self.send_json(200, {"users": []})
                return
            normalized = search.strip().lower()
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.row_factory = sqlite3.Row
                rows = connection.execute(
                    """
                    SELECT id, username, avatar_file
                    FROM users
                    WHERE username_normalized LIKE ? AND id != ?
                    ORDER BY username_normalized
                    LIMIT 10
                    """,
                    (normalized + "%", user["id"]),
                ).fetchall()
            self.send_json(200, {"users": [self.public_user(row) for row in rows]})
        except ValueError:
            self.send_json(400, {"error": "Invalid user search."})
        except sqlite3.Error:
            self.log_error("Could not search for chat users.")
            self.send_json(500, {"error": "User search is temporarily unavailable."})

    def get_conversations(self, user):
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.row_factory = sqlite3.Row
                rows = connection.execute(
                    """
                    SELECT
                        c.id,
                        other.id AS user_id,
                        other.username,
                        other.avatar_file IS NOT NULL AS has_avatar,
                        CASE WHEN last.image_file IS NOT NULL THEN 'Photo' ELSE last.body END AS last_message,
                        last.created_at AS last_message_at,
                        (
                            SELECT COUNT(*)
                            FROM messages AS unread
                            WHERE unread.conversation_id = c.id
                                AND unread.id > mine.last_read_message_id
                                AND unread.user_id != ?
                        ) AS unread_count
                    FROM conversation_members AS mine
                    JOIN conversations AS c ON c.id = mine.conversation_id
                    JOIN conversation_members AS theirs
                        ON theirs.conversation_id = c.id AND theirs.user_id != mine.user_id
                    JOIN users AS other ON other.id = theirs.user_id
                    LEFT JOIN messages AS last
                        ON last.id = (
                            SELECT MAX(recent.id)
                            FROM messages AS recent
                            WHERE recent.conversation_id = c.id
                        )
                    WHERE mine.user_id = ?
                    ORDER BY COALESCE(last.id, 0) DESC, c.id DESC
                    """,
                    (user["id"], user["id"]),
                ).fetchall()
            self.send_json(
                200,
                {"conversations": [serialize_conversation(row) for row in rows]},
            )
        except sqlite3.Error:
            self.log_error("Could not load the account chat list.")
            self.send_json(500, {"error": "Your chats are temporarily unavailable."})

    def require_profile_visibility(self, profile_user_id, viewer):
        if profile_user_id == viewer["id"]:
            return True
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                visible = connection.execute(
                    """
                    SELECT 1
                    FROM conversation_members AS viewer_member
                    JOIN conversation_members AS profile_member
                        ON profile_member.conversation_id = viewer_member.conversation_id
                    WHERE viewer_member.user_id = ? AND profile_member.user_id = ?
                    """,
                    (viewer["id"], profile_user_id),
                ).fetchone()
            if visible is None:
                self.send_json(404, {"error": "Profile not found."})
                return False
            return True
        except sqlite3.Error:
            self.log_error("Could not verify profile visibility.")
            self.send_json(500, {"error": "The profile is temporarily unavailable."})
            return False

    def get_user_profile(self, user_id, viewer):
        if not self.require_profile_visibility(user_id, viewer):
            return
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                connection.row_factory = sqlite3.Row
                profile = connection.execute(
                    "SELECT id, username, avatar_file FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
            if profile is None:
                self.send_json(404, {"error": "Profile not found."})
                return
            self.send_json(
                200,
                {
                    "user": {
                        "id": profile["id"],
                        "username": profile["username"],
                        "has_avatar": bool(profile["avatar_file"]),
                    }
                },
            )
        except sqlite3.Error:
            self.log_error("Could not load user profile.")
            self.send_json(500, {"error": "The profile is temporarily unavailable."})

    def get_user_avatar(self, user_id, viewer):
        if not self.require_profile_visibility(user_id, viewer):
            return
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                avatar = connection.execute(
                    "SELECT avatar_file, avatar_mime FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
            if avatar is None or not avatar[0]:
                self.send_json(404, {"error": "Profile photo not found."})
                return
            self.send_private_image(avatar[0], avatar[1])
        except sqlite3.Error:
            self.log_error("Could not load profile photo metadata.")
            self.send_json(500, {"error": "The profile photo is temporarily unavailable."})

    def get_conversation_image(self, conversation_id, message_id, user):
        if not self.require_conversation_membership(conversation_id, user):
            return
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                image = connection.execute(
                    """
                    SELECT image_file, image_mime
                    FROM messages
                    WHERE id = ? AND conversation_id = ?
                    """,
                    (message_id, conversation_id),
                ).fetchone()
            if image is None or not image[0]:
                self.send_json(404, {"error": "Chat image not found."})
                return
            self.send_private_image(image[0], image[1])
        except sqlite3.Error:
            self.log_error("Could not load chat image metadata.")
            self.send_json(500, {"error": "The chat image is temporarily unavailable."})

    def send_private_image(self, filename, content_type):
        upload_dir = (DATABASE_DIR / "uploads").resolve()
        image_path = (upload_dir / filename).resolve()
        if image_path.parent != upload_dir or not image_path.is_file():
            self.send_json(404, {"error": "Image not found."})
            return
        try:
            file_size = image_path.stat().st_size
            with image_path.open("rb") as image_file:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(file_size))
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Disposition", "inline")
                self.end_headers()
                while True:
                    chunk = image_file.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except OSError:
            self.log_error("Could not read private image %s.", image_path.name)

    def get_updates(self, query, user):
        try:
            after_value = self.single_query_value(query, "after_id")
            after_id = int(after_value) if after_value is not None else 0
            if after_id < 0:
                raise ValueError("after_id must not be negative.")
            with sqlite3.connect(DATABASE_PATH) as connection:
                rows = connection.execute(
                    """
                    SELECT
                        m.id,
                        m.sender,
                        m.body,
                        m.created_at,
                        m.user_id,
                        m.conversation_id,
                        COALESCE((
                            SELECT MAX(other.last_read_message_id)
                            FROM conversation_members AS other
                            WHERE other.conversation_id = m.conversation_id
                                AND other.user_id != ?
                        ), 0) AS read_through,
                        m.image_mime
                    FROM messages AS m
                    JOIN conversation_members AS member
                        ON member.conversation_id = m.conversation_id
                    WHERE member.user_id = ? AND m.id > ?
                    ORDER BY m.id ASC
                    LIMIT ?
                    """,
                    (user["id"], user["id"], after_id, MAX_MESSAGES_PER_REQUEST),
                ).fetchall()
            self.send_json(
                200,
                {
                    "messages": [
                        {
                            **serialize_message(tuple(row[:5]) + (row[6], row[7])),
                            "conversation_id": row[5],
                        }
                        for row in rows
                    ]
                },
            )
        except (TypeError, ValueError):
            self.send_json(400, {"error": "Invalid message update query."})
        except sqlite3.Error:
            self.log_error("Could not load chat updates.")
            self.send_json(500, {"error": "Chat updates are temporarily unavailable."})

    def require_conversation_membership(self, conversation_id, user):
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                row = connection.execute(
                    """
                    SELECT 1 FROM conversation_members
                    WHERE conversation_id = ? AND user_id = ?
                    """,
                    (conversation_id, user["id"]),
                ).fetchone()
            if row is None:
                self.send_json(404, {"error": "Chat not found."})
                return False
            return True
        except sqlite3.Error:
            self.log_error("Could not verify chat membership.")
            self.send_json(500, {"error": "The chat is temporarily unavailable."})
            return False

    def get_conversation_messages(self, conversation_id, query, user):
        if not self.require_conversation_membership(conversation_id, user):
            return

        try:
            limit_value = self.single_query_value(query, "limit")
            limit = int(limit_value) if limit_value is not None else DEFAULT_MESSAGES_PER_REQUEST
            if not 1 <= limit <= MAX_MESSAGES_PER_REQUEST:
                raise ValueError("Limit is out of range.")

            after_id_value = self.single_query_value(query, "after_id")
            before_id_value = self.single_query_value(query, "before_id")
            if after_id_value is not None and before_id_value is not None:
                raise ValueError("Use either after_id or before_id, not both.")

            if after_id_value is not None:
                after_id = int(after_id_value)
                if after_id < 0:
                    raise ValueError("after_id must not be negative.")
                sql = """
                    SELECT
                        m.id,
                        m.sender,
                        m.body,
                        m.created_at,
                        m.user_id,
                        COALESCE((
                            SELECT MAX(other.last_read_message_id)
                            FROM conversation_members AS other
                            WHERE other.conversation_id = m.conversation_id
                                AND other.user_id != ?
                        ), 0) AS read_through,
                        m.image_mime
                    FROM messages AS m
                    WHERE m.conversation_id = ? AND m.id > ?
                    ORDER BY m.id ASC LIMIT ?
                """
                parameters = (user["id"], conversation_id, after_id, limit)
            elif before_id_value is not None:
                before_id = int(before_id_value)
                if before_id < 1:
                    raise ValueError("before_id must be greater than zero.")
                sql = """
                    SELECT
                        m.id,
                        m.sender,
                        m.body,
                        m.created_at,
                        m.user_id,
                        COALESCE((
                            SELECT MAX(other.last_read_message_id)
                            FROM conversation_members AS other
                            WHERE other.conversation_id = m.conversation_id
                                AND other.user_id != ?
                        ), 0) AS read_through,
                        m.image_mime
                    FROM (
                        SELECT id, sender, body, created_at, user_id, conversation_id, image_mime
                        FROM messages
                        WHERE conversation_id = ? AND id < ?
                        ORDER BY id DESC LIMIT ?
                    ) AS m
                    ORDER BY m.id ASC
                """
                parameters = (user["id"], conversation_id, before_id, limit)
            else:
                sql = """
                    SELECT
                        m.id,
                        m.sender,
                        m.body,
                        m.created_at,
                        m.user_id,
                        COALESCE((
                            SELECT MAX(other.last_read_message_id)
                            FROM conversation_members AS other
                            WHERE other.conversation_id = m.conversation_id
                                AND other.user_id != ?
                        ), 0) AS read_through,
                        m.image_mime
                    FROM (
                        SELECT id, sender, body, created_at, user_id, conversation_id, image_mime
                        FROM messages
                        WHERE conversation_id = ?
                        ORDER BY id DESC LIMIT ?
                    ) AS m
                    ORDER BY m.id ASC
                """
                parameters = (user["id"], conversation_id, limit)

            with sqlite3.connect(DATABASE_PATH) as connection:
                rows = connection.execute(sql, parameters).fetchall()
            self.send_json(200, {"messages": [serialize_message(row) for row in rows]})
        except (TypeError, ValueError):
            self.send_json(400, {"error": "Invalid chat history query."})
        except sqlite3.Error:
            self.log_error("Could not read conversation history from the database.")
            self.send_json(500, {"error": "Conversation history is temporarily unavailable."})

    @staticmethod
    def single_query_value(query, name):
        values = query.get(name, [])
        if len(values) > 1:
            raise ValueError(f"{name} may only be provided once.")
        return values[0] if values else None

    def do_POST(self):
        if not self.validate_same_origin():
            return

        request_path = urlsplit(self.path).path
        conversation_route = self.conversation_route(request_path)
        conversation_upload_id = self.conversation_upload_route(request_path)
        is_avatar_upload = request_path == "/api/me/avatar"
        is_push_subscription = request_path == "/api/me/push-subscriptions"
        if request_path not in (
            "/api/signup",
            "/api/login",
            "/api/logout",
            "/api/conversations",
        ) and not is_push_subscription and not (
            conversation_route and conversation_route[1] in ("messages", "read")
        ) and not (
            conversation_upload_id is not None or is_avatar_upload
        ):
            self.send_json(404, {"error": "Not found."})
            return

        if conversation_upload_id is not None or is_avatar_upload:
            user = self.require_authenticated_user()
            if user is None:
                return
            if is_avatar_upload:
                self.save_user_avatar(user)
            else:
                self.create_conversation_image(
                    conversation_upload_id,
                    parse_qs(urlsplit(self.path).query),
                    user,
                )
            return

        payload = self.read_json_payload()
        if payload is None:
            return

        if request_path == "/api/signup":
            self.handle_signup(payload)
            return
        if request_path == "/api/login":
            self.handle_login(payload)
            return
        if request_path == "/api/logout":
            self.handle_logout()
            return

        user = self.require_authenticated_user()
        if user is None:
            return
        if is_push_subscription:
            self.save_push_subscription(payload, user)
            return
        if request_path == "/api/conversations":
            self.create_conversation(payload, user)
            return
        if conversation_route:
            conversation_id, action = conversation_route
            if action == "read":
                self.mark_conversation_read(conversation_id, payload, user)
            else:
                self.create_conversation_message(conversation_id, payload, user)
            return

    def create_conversation_message(self, conversation_id, payload, user):
        if not self.require_conversation_membership(conversation_id, user):
            return
        body = payload.get("body")
        if not isinstance(body, str) or not 1 <= len(body.strip()) <= MAX_MESSAGE_LENGTH:
            self.send_json(400, {"error": "Messages must be between 1 and 2000 characters."})
            return

        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                cursor = connection.execute(
                    """
                    INSERT INTO messages (sender, client_id, body, created_at, user_id, conversation_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user["username"],
                        str(user["id"]),
                        body.strip(),
                        created_at,
                        user["id"],
                        conversation_id,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT id, sender, body, created_at, user_id
                    FROM messages WHERE id = ?
                    """,
                    (cursor.lastrowid,),
                ).fetchone()
            self.send_push_notifications(conversation_id, user, row[0])
            self.send_json(201, {"message": serialize_message(row)})
        except sqlite3.Error:
            self.log_error("Could not save chat message to the database.")
            self.send_json(500, {"error": "Your message could not be saved. Please try again."})

    def store_uploaded_image(self):
        content_type = self.headers.get_content_type().lower()
        if content_type not in IMAGE_TYPES:
            self.send_json(415, {"error": "Use a JPEG, PNG, or WebP image."})
            return None
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid image size."})
            return None
        if content_length < 1:
            self.send_json(400, {"error": "Choose a non-empty image."})
            return None
        if content_length > MAX_IMAGE_UPLOAD_BYTES:
            self.send_json(413, {"error": "Images must be no larger than 200 MB."})
            return None

        upload_dir = DATABASE_DIR / "uploads"
        try:
            upload_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=upload_dir, delete=False) as temp_file:
                temp_path = Path(temp_file.name)
                remaining = content_length
                signature = bytearray()
                while remaining:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        self.send_json(400, {"error": "The image upload was incomplete."})
                        return None
                    if len(signature) < 12:
                        signature.extend(chunk[:12 - len(signature)])
                    temp_file.write(chunk)
                    remaining -= len(chunk)

            if content_type == "image/webp":
                valid_image = (
                    signature[:4] == b"RIFF"
                    and signature[8:12] == b"WEBP"
                )
            else:
                valid_image = signature.startswith(IMAGE_TYPES[content_type][0])
            if not valid_image:
                self.send_json(415, {"error": "The selected file is not a valid JPEG, PNG, or WebP image."})
                return None

            extension = IMAGE_TYPES[content_type][1]
            filename = f"{secrets.token_hex(24)}{extension}"
            os.replace(temp_path, upload_dir / filename)
            return filename, content_type
        except OSError:
            self.log_error("Could not save uploaded image.")
            self.send_json(500, {"error": "The image could not be saved. Please try again."})
            return None
        finally:
            if "temp_path" in locals() and temp_path.exists():
                temp_path.unlink()

    def save_user_avatar(self, user):
        uploaded = self.store_uploaded_image()
        if uploaded is None:
            return
        filename, content_type = uploaded
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                old_avatar = connection.execute(
                    "SELECT avatar_file FROM users WHERE id = ?",
                    (user["id"],),
                ).fetchone()[0]
                connection.execute(
                    "UPDATE users SET avatar_file = ?, avatar_mime = ? WHERE id = ?",
                    (filename, content_type, user["id"]),
                )
            if old_avatar:
                try:
                    (DATABASE_DIR / "uploads" / old_avatar).unlink(missing_ok=True)
                except OSError:
                    self.log_error("Could not remove the replaced profile photo.")
            self.send_json(200, {"ok": True})
        except sqlite3.Error:
            try:
                (DATABASE_DIR / "uploads" / filename).unlink(missing_ok=True)
            except OSError:
                self.log_error("Could not remove an unsaved profile photo.")
            self.log_error("Could not update the profile photo.")
            self.send_json(500, {"error": "The profile photo could not be updated."})

    def create_conversation_image(self, conversation_id, query, user):
        if not self.require_conversation_membership(conversation_id, user):
            return
        try:
            caption = self.single_query_value(query, "caption") or ""
        except ValueError:
            self.send_json(400, {"error": "Invalid image caption."})
            return
        if len(caption) > MAX_MESSAGE_LENGTH:
            self.send_json(400, {"error": "Image captions must be no longer than 2000 characters."})
            return

        uploaded = self.store_uploaded_image()
        if uploaded is None:
            return
        filename, content_type = uploaded
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            with sqlite3.connect(DATABASE_PATH) as connection:
                cursor = connection.execute(
                    """
                    INSERT INTO messages
                        (sender, client_id, body, created_at, user_id, conversation_id, image_file, image_mime)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user["username"],
                        str(user["id"]),
                        caption.strip(),
                        created_at,
                        user["id"],
                        conversation_id,
                        filename,
                        content_type,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT id, sender, body, created_at, user_id, image_mime
                    FROM messages WHERE id = ?
                    """,
                    (cursor.lastrowid,),
                ).fetchone()
            self.send_push_notifications(conversation_id, user, row[0])
            self.send_json(201, {"message": serialize_message(tuple(row[:5]) + (0, row[5]))})
        except sqlite3.Error:
            try:
                (DATABASE_DIR / "uploads" / filename).unlink(missing_ok=True)
            except OSError:
                self.log_error("Could not remove an unsaved chat image.")
            self.log_error("Could not save chat image to the database.")
            self.send_json(500, {"error": "The image could not be sent. Please try again."})

    def serve_static_file(self, request_path):
        relative_path = unquote(request_path).lstrip("/") or "index.html"
        file_path = (APP_DIR / relative_path).resolve()
        is_public_file = relative_path in PUBLIC_FILES
        is_public_icon = relative_path.startswith("icons/") and relative_path[6:] in PUBLIC_ICON_FILES
        if not (is_public_file or is_public_icon) or APP_DIR not in file_path.parents or not file_path.is_file():
            self.send_error(404, "File not found.")
            return

        content_type, _ = mimetypes.guess_type(file_path.name)
        content_type = content_type or "application/octet-stream"
        if file_path.suffix == ".webmanifest":
            content_type = "application/manifest+json"

        try:
            content = file_path.read_bytes()
        except OSError:
            self.log_error("Could not read static file %s.", file_path)
            self.send_error(500, "File unavailable.")
            return

        self.send_response(200)
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "application/manifest+json",
        ):
            content_type = f"{content_type}; charset=utf-8"
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if file_path.suffix in (".html", ".js", ".css", ".webmanifest"):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

def main():
    parser = argparse.ArgumentParser(description="Run the PWA and its SQLite-backed chat.")
    parser.add_argument("--host", default="127.0.0.1", help="Address to listen on (default: 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000).")
    parser.add_argument(
        "--secure-cookies",
        action="store_true",
        help="Mark account cookies Secure when HTTPS is terminated by a trusted reverse proxy.",
    )
    arguments = parser.parse_args()

    initialize_database()
    server = ThreadingHTTPServer((arguments.host, arguments.port), PwaRequestHandler)
    server.secure_cookies = arguments.secure_cookies
    print(f"Murmur is available at http://{arguments.host}:{arguments.port}")
    print(f"Chat history is stored in {DATABASE_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Murmur.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
