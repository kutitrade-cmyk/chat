# Murmur

Murmur is a small Progressive Web App with username/password accounts and private, one-to-one conversations backed by Python and SQLite. It can be installed from supported browsers, opens in an app-style window, and caches its pages for offline use.

## Run locally

Python 3 and the dependencies in `requirements.txt` are required. Install them and run the app from the project folder:

```shell
python -m pip install -r requirements.txt
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

Install the Web Push dependency in the PythonAnywhere console after pulling an update:

```shell
cd ~/chat
python3.12 -m pip install --user -r requirements.txt
```

To enable closed-app push, create a VAPID key pair once in the PythonAnywhere console:

```shell
python3.12 -c "from py_vapid import Vapid; from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat; import base64; v=Vapid(); v.generate_keys(); enc=lambda b:base64.urlsafe_b64encode(b).rstrip(b'=').decode(); print('MURMUR_VAPID_PUBLIC_KEY='+enc(v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))); print('MURMUR_VAPID_PRIVATE_KEY='+enc(v.private_key.private_numbers().private_value.to_bytes(32, 'big')))"
```

Keep the private key secret. Copy the generated public and private values into the WSGI configuration file as environment variables **before** `from wsgi_app import application`:

```python
import os

os.environ["MURMUR_VAPID_PUBLIC_KEY"] = "<generated public key>"
os.environ["MURMUR_VAPID_PRIVATE_KEY"] = "<generated private key>"
os.environ["MURMUR_VAPID_SUBJECT"] = "mailto:<your-contact-email>"
```

Save and reload the web app after installing dependencies and setting the keys. Each user must then open their Murmur profile and enable push notifications on each device/browser they want to receive alerts on. To rotate VAPID keys, users need to disable and re-enable their push subscription.

Service workers and notifications need a secure context. `localhost` is treated as secure for local development; when deployed for other devices, serve the app over HTTPS. The development server is not production hosting: it has no email verification, password reset, account recovery, or production hardening. Do not expose it to the internet as-is. For an HTTPS deployment behind a trusted reverse proxy, use `python app.py --host 127.0.0.1 --secure-cookies` so account session cookies are marked `Secure`.

To install the app, use your browser's install or **Add to Home Screen** option when available. On iPhone or iPad, open the page in Safari, tap **Share**, choose **Add to Home Screen**, then tap **Add** to confirm.

## Notifications

Enable push notifications in your own profile. The test button there checks whether your browser can display a notification. Push notifications can arrive while Murmur is closed after the server has been configured with VAPID keys and you have enabled push on the device. Notifications while Murmur is open continue to use chat polling. Signing out removes that browser's push subscription; enable it again after signing back in if you want to keep receiving closed-app alerts.

Browser, operating-system, and installation requirements vary. For example, iOS/iPadOS web notifications require a home-screen-installed app and a supported system version.
