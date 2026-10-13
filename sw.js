const CACHE_NAME = "murmur-shell-v21";
const APP_SHELL = [
  "./",
  "./index.html",
  "./login.html",
  "./register.html",
  "./conversation.html",
  "./profile.html",
  "./styles.css",
  "./app.js",
  "./auth.js",
  "./inbox.js",
  "./conversation.js",
  "./profile.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

function resolveAppUrl(value) {
  try {
    const scope = self.registration.scope;
    const url = new URL(typeof value === "string" ? value : "./", scope);
    if (url.origin === new URL(scope).origin && url.href.startsWith(scope)) {
      return url.href;
    }
  } catch (error) {
    console.error("Notification URL was invalid.", error);
  }
  return self.registration.scope;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  const apiPath = new URL("./api/", self.registration.scope).pathname;
  if (
    request.method !== "GET"
    || requestUrl.origin !== self.location.origin
    || requestUrl.pathname.startsWith(apiPath)
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cachedPage = await caches.match(request, { ignoreSearch: true });
        return cachedPage || caches.match("./index.html");
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((response) => {
        if (!response.ok) {
          return response;
        }
        return caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, response.clone()))
          .then(() => response);
      });
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = {};

  if (event.data) {
    try {
      payload = event.data.json();
    } catch (error) {
      console.error("Push message was not valid JSON.", error);
      payload = { body: event.data.text() };
    }
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    payload = {};
  }

  const title = typeof payload.title === "string" ? payload.title : "Murmur";
  const body = typeof payload.body === "string" ? payload.body : "You have a new notification.";
  const safeUrl = resolveAppUrl(payload.url);
  const tag = typeof payload.tag === "string" ? payload.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "./icons/icon.svg",
      badge: "./icons/icon.svg",
      tag,
      data: { url: safeUrl },
      actions: [{ action: "open", title: "Open app" }]
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requestedUrl = event.notification.data && event.notification.data.url;
  const safeUrl = resolveAppUrl(requestedUrl);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            if (client.url !== safeUrl && "navigate" in client) {
              return client.navigate(safeUrl).then(() => client.focus());
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(safeUrl);
      })
  );
});
