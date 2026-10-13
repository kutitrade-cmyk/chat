import gc
import io
import json
import os
import tempfile
import unittest
from http.cookies import SimpleCookie
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


if __name__ == "__main__":
    unittest.main()
