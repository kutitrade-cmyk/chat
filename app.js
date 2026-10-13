let installPrompt;
const isIosDevice = /iPad|iPhone|iPod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installStatus = {
  android: /Android/i.test(navigator.userAgent),
  installed: window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true,
  promptAvailable: false
};

window.murmurInstallStatus = installStatus;
window.murmurNotificationPlatform = {
  isIos: isIosDevice,
  isStandalone: installStatus.installed
};

function decodeApplicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

window.murmurEnableNotifications = async () => {
  if (!window.isSecureContext || !("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new Error("This browser or connection does not support secure web notifications.");
  }
  if (isIosDevice && !installStatus.installed) {
    throw new Error("On iPhone or iPad, first add Murmur to your Home Screen and open it from there.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { permission, pushEnabled: false };
  }

  const configResponse = await fetch("./api/me/push-config", {
    headers: { Accept: "application/json" }
  });
  const configuration = await configResponse.json();
  if (!configResponse.ok) {
    throw new Error(configuration.error || "Could not load push notification settings.");
  }
  if (!configuration.enabled || !configuration.public_key || !("PushManager" in window)) {
    return { permission, pushEnabled: false };
  }

  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = decodeApplicationServerKey(configuration.public_key);
  let subscription = await registration.pushManager.getSubscription();
  const existingKey = subscription?.options.applicationServerKey;
  const existingKeyBytes = existingKey ? new Uint8Array(existingKey) : null;
  const keyMatches = existingKey
    && existingKeyBytes.byteLength === applicationServerKey.byteLength
    && applicationServerKey.every((byte, index) => byte === existingKeyBytes[index]);
  if (subscription && !keyMatches) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
  }

  try {
    const response = await fetch("./api/me/push-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(subscription.toJSON())
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not enable push notifications.");
    }
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }
  return { permission, pushEnabled: true };
};

window.murmurInstallApp = async () => {
  if (!installPrompt) {
    return "manual";
  }

  const prompt = installPrompt;
  installPrompt = undefined;
  installStatus.promptAvailable = false;
  window.dispatchEvent(new Event("murmurinstallchange"));
  await prompt.prompt();
  const choice = await prompt.userChoice;
  return choice.outcome;
};

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installStatus.promptAvailable = true;
  window.dispatchEvent(new Event("murmurinstallchange"));
});

window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  installStatus.installed = true;
  window.murmurNotificationPlatform.isStandalone = true;
  installStatus.promptAvailable = false;
  window.dispatchEvent(new Event("murmurinstallchange"));
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("Could not register the service worker.", error);
    });
  }, { once: true });
}
