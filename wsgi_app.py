import email.message
import html
import logging
from http import HTTPStatus
from tempfile import SpooledTemporaryFile
from types import SimpleNamespace

import app as murmur


logger = logging.getLogger("murmur")
murmur.initialize_database()


class WsgiRequestHandler(murmur.PwaRequestHandler):
    def send_response(self, code, message=None):
        self._response_status = code
        self._response_headers = []

    def send_header(self, keyword, value):
        self._response_headers.append((keyword, str(value)))

    def end_headers(self):
        self._headers_sent = True

    def send_error(self, code, message=None, explain=None):
        reason = message or HTTPStatus(code).phrase
        content = (
            "<!doctype html><html><head><title>Error</title></head>"
            f"<body><h1>{code} {html.escape(reason)}</h1></body></html>"
        ).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_error(self, format, *args):
        logger.error(format, *args)


def _request_headers(environ):
    headers = email.message.Message()
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            name = key[5:].replace("_", "-").title()
            headers[name] = value

    if "Host" not in headers:
        headers["Host"] = environ.get("SERVER_NAME", "localhost")
        port = environ.get("SERVER_PORT")
        if port and port not in ("80", "443"):
            headers["Host"] += f":{port}"
    if environ.get("CONTENT_TYPE"):
        headers["Content-Type"] = environ["CONTENT_TYPE"]
    if environ.get("CONTENT_LENGTH"):
        headers["Content-Length"] = environ["CONTENT_LENGTH"]
    return headers


def application(environ, start_response):
    method = environ.get("REQUEST_METHOD", "GET").upper()
    handler = WsgiRequestHandler.__new__(WsgiRequestHandler)
    handler.command = method
    handler.path = environ.get("PATH_INFO", "/")
    query = environ.get("QUERY_STRING", "")
    if query:
        handler.path += f"?{query}"
    handler.headers = _request_headers(environ)
    handler.rfile = environ["wsgi.input"]
    handler.wfile = SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b")
    handler.server = SimpleNamespace(secure_cookies=True)
    handler._response_status = 500
    handler._response_headers = []
    handler._headers_sent = False

    if method in ("GET", "POST"):
        getattr(handler, f"do_{method}")()
    else:
        handler.send_error(405, "Method not allowed.")

    if not handler._headers_sent:
        handler.send_error(500, "The application did not complete its response.")

    status = handler._response_status
    start_response(
        f"{status} {HTTPStatus(status).phrase}",
        handler._response_headers,
    )
    handler.wfile.seek(0)

    def response_body():
        try:
            while chunk := handler.wfile.read(64 * 1024):
                yield chunk
        finally:
            handler.wfile.close()

    return response_body()
