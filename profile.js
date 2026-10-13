const profileBackLink = document.querySelector("#profile-back-link");
const profileBackLabel = document.querySelector("#profile-back-label");
const profileAvatar = document.querySelector("#profile-avatar");
const profileUsername = document.querySelector("#profile-username");
const profilePhotoForm = document.querySelector("#profile-photo-form");
const profilePhotoInput = document.querySelector("#profile-photo-input");
const profilePhotoSelection = document.querySelector("#profile-photo-selection");
const saveProfilePhotoButton = document.querySelector("#save-profile-photo");
const profileStatus = document.querySelector("#profile-status");
const notificationSettings = document.querySelector("#notification-settings");
const enableNotificationsButton = document.querySelector("#enable-notifications");
const testNotificationButton = document.querySelector("#test-notification");
const notificationSettingsStatus = document.querySelector("#notification-settings-status");

const MAX_PROFILE_IMAGE_SIZE = 200 * 1024 * 1024;
let pushSubscription;
let pushConfiguration;

function setProfileStatus(message, isError = false) {
  profileStatus.textContent = message;
  profileStatus.classList.toggle("status-error", isError);
}

function setNotificationStatus(message, isError = false) {
  notificationSettingsStatus.textContent = message;
  notificationSettingsStatus.classList.toggle("status-error", isError);
}

async function loadPushSettings() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !window.isSecureContext) {
    enableNotificationsButton.hidden = true;
    testNotificationButton.hidden = true;
    setNotificationStatus("This browser or connection does not support secure web notifications.", true);
    return;
  }
  if (window.murmurNotificationPlatform?.isIos && !window.murmurNotificationPlatform.isStandalone) {
    enableNotificationsButton.hidden = true;
    testNotificationButton.hidden = true;
    setNotificationStatus("On iPhone or iPad, add Murmur to your Home Screen and open it from there before enabling notifications.");
    return;
  }
  if (!("PushManager" in window)) {
    enableNotificationsButton.hidden = Notification.permission === "denied";
    enableNotificationsButton.textContent = "Enable notifications";
    testNotificationButton.hidden = Notification.permission !== "granted";
    setNotificationStatus("This browser can show notifications while Murmur is open but does not support closed-app push.");
    return;
  }

  try {
    const response = await fetch("./api/me/push-config", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not load push notification settings.");
    }
    pushConfiguration = data;
    const registration = await navigator.serviceWorker.ready;
    pushSubscription = await registration.pushManager.getSubscription();
  } catch (error) {
    console.error("Could not load push notification settings.", error);
    enableNotificationsButton.hidden = true;
    testNotificationButton.hidden = Notification.permission !== "granted";
    setNotificationStatus("Could not load push notification settings. Check your connection and try again.", true);
    return;
  }

  if (pushSubscription) {
    enableNotificationsButton.hidden = false;
    enableNotificationsButton.textContent = "Turn off push notifications";
    testNotificationButton.hidden = Notification.permission !== "granted";
    setNotificationStatus("A push subscription is active. Turn it off here to stop closed-app alerts.");
  } else if (Notification.permission === "granted") {
    enableNotificationsButton.hidden = !pushConfiguration.enabled;
    enableNotificationsButton.textContent = "Enable push notifications";
    testNotificationButton.hidden = false;
    if (!pushConfiguration.enabled) {
      setNotificationStatus("This server is not configured for closed-app push yet. Notifications while Murmur is open still work.");
    } else {
      setNotificationStatus("Browser notifications are allowed. Enable push to receive alerts while Murmur is closed.");
    }
  } else if (Notification.permission === "denied") {
    enableNotificationsButton.hidden = true;
    testNotificationButton.hidden = true;
    setNotificationStatus("Notifications are blocked. Allow them in your browser or device settings to enable alerts.", true);
  } else {
    enableNotificationsButton.hidden = false;
    enableNotificationsButton.textContent = "Enable push notifications";
    testNotificationButton.hidden = true;
    setNotificationStatus(pushConfiguration.enabled
      ? "Enable notifications to receive new-message alerts, including when Murmur is closed."
      : "Enable notifications to receive alerts while Murmur is open. Closed-app push is not configured on this server yet.");
  }
}

enableNotificationsButton.addEventListener("click", async () => {
  enableNotificationsButton.disabled = true;
  try {
    if (pushSubscription) {
      const response = await fetch("./api/me/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ endpoint: pushSubscription.endpoint, enabled: false })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not turn off push notifications.");
      }
      const unsubscribed = await pushSubscription.unsubscribe();
      if (!unsubscribed) {
        throw new Error("The browser could not turn off this push subscription.");
      }
      pushSubscription = null;
      setNotificationStatus("Push notifications are turned off. Notifications while Murmur is open may still appear.");
    } else {
      const result = await window.murmurEnableNotifications();
      if (result.permission !== "granted") {
        await loadPushSettings();
        return;
      }
      setNotificationStatus(result.pushEnabled
        ? "Push notifications are enabled. New messages can alert you while Murmur is closed."
        : "Notifications are allowed on this device. Closed-app push is not configured on this server yet.");
    }
    await loadPushSettings();
  } catch (error) {
    console.error("Could not request notification permission.", error);
    setNotificationStatus(error.message || "The browser could not update push settings. Check its site permissions and try again.", true);
  } finally {
    enableNotificationsButton.disabled = false;
  }
});

testNotificationButton.addEventListener("click", async () => {
  testNotificationButton.disabled = true;
  setNotificationStatus("Sending a test notification…");
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Murmur notification test", {
      body: "Your browser accepted a test alert from Murmur.",
      icon: "./icons/icon.svg",
      badge: "./icons/icon.svg",
      tag: "murmur-notification-test",
      data: { url: "./index.html" }
    });
    setNotificationStatus("Test notification sent. Check your browser or device notification center.");
  } catch (error) {
    console.error("Could not send a test notification.", error);
    setNotificationStatus("Could not send a test notification. Check your browser and device notification settings.", true);
  } finally {
    testNotificationButton.disabled = false;
  }
});

window.addEventListener("focus", loadPushSettings);

function createProfileError(response, data) {
  const error = new Error(data.error || "Could not load the profile.");
  error.status = response.status;
  return error;
}

async function loadJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok) {
    throw createProfileError(response, data);
  }
  return data;
}

function showProfilePhoto(user, version = "") {
  profileAvatar.textContent = user.username.slice(0, 1).toUpperCase();
  if (!user.has_avatar) {
    return;
  }
  const image = new Image();
  image.className = "avatar-photo";
  image.alt = "";
  image.src = `./api/users/${user.id}/avatar${version}`;
  image.addEventListener("error", () => image.remove());
  profileAvatar.append(image);
}

function setBackLink(parameters) {
  if (parameters.get("from") === "conversation") {
    const conversationId = Number(parameters.get("conversation"));
    if (Number.isInteger(conversationId) && conversationId > 0) {
      profileBackLink.href = `./conversation.html?conversation=${conversationId}`;
      profileBackLabel.textContent = "Back to chat";
    }
  }
}

profilePhotoInput.addEventListener("change", () => {
  const photo = profilePhotoInput.files[0];
  saveProfilePhotoButton.disabled = !photo;
  if (!photo) {
    profilePhotoSelection.textContent = "JPEG, PNG, or WebP · up to 200 MB";
    return;
  }
  if (photo.size < 1 || photo.size > MAX_PROFILE_IMAGE_SIZE) {
    profilePhotoInput.value = "";
    saveProfilePhotoButton.disabled = true;
    setProfileStatus("Choose a non-empty image no larger than 200 MB.", true);
    return;
  }
  profilePhotoSelection.textContent = `${photo.name} · ${(photo.size / (1024 * 1024)).toFixed(1)} MB`;
  setProfileStatus("");
});

profilePhotoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const photo = profilePhotoInput.files[0];
  if (!photo || saveProfilePhotoButton.disabled) {
    return;
  }
  saveProfilePhotoButton.disabled = true;
  setProfileStatus("Uploading profile photo…");
  try {
    const response = await fetch("./api/me/avatar", {
      method: "POST",
      headers: { "Content-Type": photo.type, Accept: "application/json" },
      body: photo
    });
    const data = await response.json();
    if (!response.ok) {
      throw createProfileError(response, data);
    }
    profilePhotoInput.value = "";
    profilePhotoSelection.textContent = "JPEG, PNG, or WebP · up to 200 MB";
    showProfilePhoto({ id: Number(profileAvatar.dataset.userId), username: profileUsername.textContent, has_avatar: true }, `?v=${Date.now()}`);
    setProfileStatus("Profile photo updated.");
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
      return;
    }
    console.error("Could not save profile photo.", error);
    setProfileStatus(error.message || "Could not save the profile photo. Please try again.", true);
  } finally {
    saveProfilePhotoButton.disabled = !profilePhotoInput.files[0];
  }
});

async function initializeProfile() {
  const parameters = new URLSearchParams(window.location.search);
  setBackLink(parameters);
  const profileId = Number(parameters.get("user"));
  if (!Number.isInteger(profileId) || profileId < 1) {
    window.location.replace("./index.html");
    return;
  }

  try {
    const session = await loadJson("./api/me");
    if (!session.user) {
      window.location.replace("./login.html");
      return;
    }
    const data = await loadJson(`./api/users/${profileId}/profile`);
    const user = data.user;
    const isOwnProfile = user.id === session.user.id;
    profileUsername.textContent = user.username;
    profileAvatar.dataset.userId = String(user.id);
    showProfilePhoto(user);
    if (isOwnProfile) {
      profilePhotoForm.hidden = false;
      notificationSettings.hidden = false;
      await loadPushSettings();
      profilePhotoSelection.textContent = user.has_avatar
        ? "Choose a new photo · JPEG, PNG, or WebP · up to 200 MB"
        : "JPEG, PNG, or WebP · up to 200 MB";
    }
    document.title = `${user.username} | Profile`;
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
      return;
    }
    console.error("Could not open user profile.", error);
    profileUsername.textContent = "Profile unavailable";
    setProfileStatus(error.message || "Could not load this profile. Please try again.", true);
  }
}

initializeProfile();
