# Murmur

Murmur is a small Progressive Web App with username/password accounts and private, one-to-one conversations backed by Python and SQLite. It can be installed from supported browsers, opens in an app-style window, and caches its pages for offline use.

## Run locally

Python 3 is required; the app uses only Python's standard library. Run the app and its chat API from the project folder:

```shell
python app.py
```

Then open <http://localhost:8000>. New users can register at `/register.html`; existing users sign in at `/login.html`. After signing in, the inbox is at `/index.html`. Search for a username in the inbox and select a result to start a private conversation; you can also submit a complete username directly. In a chat, select the other person's profile to view it; select your own profile from the inbox to add or change your photo. Chats support text and JPEG, PNG, and WebP image messages, up to 200 MB per image. Uploaded photos and images are stored privately under `data/uploads`; messages and account records are saved in `data/chat.sqlite3`. Password hashes are salted and derived with PBKDF2-HMAC-SHA256. The development server binds to `127.0.0.1` by default.

## Deploying on PythonAnywhere

Clone the repository into `/home/<your-username>/chat`. In the PythonAnywhere **Web** tab, set the source code and working directory to `/home/<your-username>/chat`, then edit the web app's WSGI configuration file to load Murmur:

```python
import sys

project_home = "/home/<your-username>/chat"
if project_home not in sys.path:
    sys.path.insert(0, project_home)

from wsgi_app import application
```

Replace `<your-username>` with the exact capitalization of your PythonAnywhere username. Murmur initializes its SQLite database under `chat/data` when the WSGI application starts. Keep that directory writable and persistent; it also stores uploaded images. Reload the web app after saving the WSGI file. PythonAnywhere supplies HTTPS, and the WSGI adapter marks sign-in cookies as secure.

Service workers and notifications need a secure context. `localhost` is treated as secure for local development; when deployed for other devices, serve the app over HTTPS. The development server is not production hosting: it has no email verification, password reset, account recovery, or production hardening. Do not expose it to the internet as-is. For an HTTPS deployment behind a trusted reverse proxy, use `python app.py --host 127.0.0.1 --secure-cookies` so account session cookies are marked `Secure`.

To install the app, use your browser's install or **Add to Home Screen** option when available. On iPhone or iPad, open the page in Safari, tap **Share**, choose **Add to Home Screen**, then tap **Add** to confirm.

## Notifications

Enable message notifications in your own profile. Use the test button there to check that your browser can display notifications. While Murmur is open in a background tab, it checks the chat server for messages and displays a notification when another account sends one. If the browser blocks notifications, allow them in its site settings and try again.

Message polling runs while Murmur is open; browser polling cannot continue after all app tabs have been closed. Receiving chat notifications while the app is fully closed requires a push service, VAPID keys, and client-side push subscription management. Those are not configured yet.

Browser, operating-system, and installation requirements vary. For example, iOS/iPadOS web notifications require a home-screen-installed app and a supported system version.
