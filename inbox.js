const signedInUsername = document.querySelector("#signed-in-username");
const profileLink = document.querySelector("#profile-link");
const accountAvatar = document.querySelector("#account-avatar");
const signoutButton = document.querySelector("#signout-button");
const conversationList = document.querySelector("#conversation-list");
const conversationListEmpty = document.querySelector("#conversation-list-empty");
const newChatForm = document.querySelector("#new-chat-form");
const newChatUsername = document.querySelector("#new-chat-username");
const userSearchResults = document.querySelector("#user-search-results");
const newChatStatus = document.querySelector("#new-chat-status");
const chatStatus = document.querySelector("#chat-status");
const startChatButton = newChatForm.querySelector('button[type="submit"]');

let conversations = [];
let currentUser;
let latestUpdateMessageId = 0;
let serviceWorkerRegistration;
let isPolling = false;
let isOpeningConversation = false;
let searchTimeout;
let searchRequestId = 0;
const CHAT_POLL_INTERVAL_MS = 3000;
const USER_SEARCH_DELAY_MS = 180;

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("status-error", isError);
}

function getError(response, data, fallback) {
  const error = new Error(data.error || fallback);
  error.status = response.status;
  return error;
}

async function getCurrentUser() {
  const response = await fetch("./api/me", { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok) {
    throw getError(response, data, "Could not check your account.");
  }
  return data.user;
}

function formatMessageTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function addAvatarPhoto(container, user) {
  if (!user.has_avatar) {
    return;
  }
  const avatar = new Image();
  avatar.className = "avatar-photo";
  avatar.alt = "";
  avatar.src = `./api/users/${user.id}/avatar`;
  avatar.addEventListener("error", () => avatar.remove());
  container.append(avatar);
}

function renderConversations() {
  conversationList.replaceChildren();
  conversationListEmpty.hidden = conversations.length > 0;

  if (conversations.length === 0) {
    conversationList.append(conversationListEmpty);
    return;
  }

  for (const conversation of conversations) {
    const unreadCount = Number(conversation.unread_count) || 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.classList.toggle("conversation-item-unread", unreadCount > 0);
    button.setAttribute(
      "aria-label",
      unreadCount > 0
        ? `Chat with ${conversation.username}, ${unreadCount} unread messages`
        : `Chat with ${conversation.username}`
    );
    button.addEventListener("click", () => {
      window.location.href = `./conversation.html?conversation=${conversation.id}`;
    });

    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = conversation.username.slice(0, 1).toUpperCase();
    addAvatarPhoto(avatar, conversation);

    const details = document.createElement("span");
    details.className = "conversation-item-details";
    const name = document.createElement("span");
    name.className = "conversation-item-name";
    name.textContent = conversation.username;
    const preview = document.createElement("span");
    preview.className = "conversation-item-preview";
    preview.textContent = conversation.last_message || "Start the conversation";
    details.append(name, preview);

    const meta = document.createElement("span");
    meta.className = "conversation-item-meta";
    const timeText = formatMessageTime(conversation.last_message_at);
    if (timeText) {
      const time = document.createElement("time");
      time.dateTime = conversation.last_message_at;
      time.textContent = timeText;
      meta.append(time);
    }
    if (unreadCount > 0) {
      const unread = document.createElement("span");
      unread.className = "conversation-unread";
      unread.textContent = String(unreadCount);
      unread.setAttribute("aria-hidden", "true");
      meta.append(unread);
    }

    button.append(avatar, details, meta);
    conversationList.append(button);
  }
}

async function loadConversations() {
  const response = await fetch("./api/conversations", { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok) {
    throw getError(response, data, "Your chats could not be loaded.");
  }
  conversations = data.conversations;
  renderConversations();
}

function renderUserSearchResults(users) {
  userSearchResults.replaceChildren();
  userSearchResults.hidden = users.length === 0;

  for (const user of users) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "user-search-result";
    button.addEventListener("click", () => openConversation(user.username, button));

    const avatar = document.createElement("span");
    avatar.className = "conversation-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = user.username.slice(0, 1).toUpperCase();
    addAvatarPhoto(avatar, user);

    const username = document.createElement("span");
    username.className = "user-search-result-name";
    username.textContent = user.username;

    const action = document.createElement("span");
    action.className = "user-search-result-action";
    action.textContent = "Message";

    button.append(avatar, username, action);
    item.append(button);
    userSearchResults.append(item);
  }
}

async function searchUsers(search, requestId) {
  try {
    const response = await fetch(`./api/users?search=${encodeURIComponent(search)}`, {
      headers: { Accept: "application/json" }
    });
    const data = await response.json();
    if (!response.ok) {
      throw getError(response, data, "Could not search for people.");
    }
    if (requestId !== searchRequestId) {
      return;
    }

    renderUserSearchResults(data.users);
    setStatus(
      newChatStatus,
      data.users.length > 0
        ? "Choose someone to open a private chat."
        : "No usernames match that search."
    );
  } catch (error) {
    if (requestId !== searchRequestId) {
      return;
    }
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not search for chat users.", error);
      renderUserSearchResults([]);
      setStatus(newChatStatus, error.message || "Could not search for people. Please try again.", true);
    }
  }
}

newChatUsername.addEventListener("input", () => {
  const search = newChatUsername.value.trim();
  searchRequestId += 1;
  const requestId = searchRequestId;
  window.clearTimeout(searchTimeout);
  renderUserSearchResults([]);

  if (search.length < 2) {
    setStatus(newChatStatus, search ? "Enter at least 2 characters to search." : "");
    return;
  }

  setStatus(newChatStatus, "Searching usernames…");
  searchTimeout = window.setTimeout(() => searchUsers(search, requestId), USER_SEARCH_DELAY_MS);
});

async function openConversation(username, trigger) {
  if (isOpeningConversation) {
    return;
  }
  isOpeningConversation = true;
  startChatButton.disabled = true;
  trigger.disabled = true;
  setStatus(newChatStatus, "Opening chat…");
  try {
    const response = await fetch("./api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username })
    });
    const data = await response.json();
    if (!response.ok) {
      throw getError(response, data, "Could not start that chat.");
    }

    window.location.href = `./conversation.html?conversation=${data.conversation_id}`;
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not start a private chat.", error);
      setStatus(newChatStatus, error.message || "Could not start that chat. Please try again.", true);
    }
  } finally {
    isOpeningConversation = false;
    startChatButton.disabled = false;
    trigger.disabled = false;
  }
}

newChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = newChatUsername.value.trim();
  if (username) {
    await openConversation(username, startChatButton);
  }
});

async function showNotification(message) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  if (!serviceWorkerRegistration) {
    serviceWorkerRegistration = await navigator.serviceWorker.ready;
  }
  await serviceWorkerRegistration.showNotification(`New message from ${message.sender}`, {
    body: message.body || "You received an image.",
    icon: "./icons/icon.svg",
    badge: "./icons/icon.svg",
    tag: `chat-message-${message.id}`,
    data: { url: `./conversation.html?conversation=${message.conversation_id}` },
    actions: [{ action: "open", title: "Open chat" }]
  });
}

async function pollUpdates() {
  if (isPolling) {
    return;
  }
  isPolling = true;
  try {
    const response = await fetch(`./api/updates?after_id=${latestUpdateMessageId}`, {
      headers: { Accept: "application/json" }
    });
    const data = await response.json();
    if (!response.ok) {
      throw getError(response, data, "Could not check for chat updates.");
    }

    for (const message of data.messages) {
      latestUpdateMessageId = Math.max(latestUpdateMessageId, message.id);
      if (document.hidden && message.user_id !== currentUser.id) {
        try {
          await showNotification(message);
        } catch (error) {
          console.error("Could not show a notification for the new chat message.", error);
        }
      }
    }
    await loadConversations();
    setStatus(chatStatus, "Connected");
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not refresh the chat list.", error);
      setStatus(chatStatus, "Reconnecting to chat…", true);
    }
  } finally {
    isPolling = false;
  }
}

signoutButton.addEventListener("click", async () => {
  signoutButton.disabled = true;
  try {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const unsubscribeResponse = await fetch("./api/me/push-subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint, enabled: false })
        });
        const unsubscribeData = await unsubscribeResponse.json();
        if (!unsubscribeResponse.ok) {
          throw getError(unsubscribeResponse, unsubscribeData, "Could not turn off push notifications before signing out.");
        }
        if (!await subscription.unsubscribe()) {
          throw new Error("The browser could not turn off push notifications before signing out.");
        }
      }
    }
    const response = await fetch("./api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}"
    });
    const data = await response.json();
    if (!response.ok) {
      throw getError(response, data, "Could not sign out.");
    }
    window.location.replace("./login.html");
  } catch (error) {
    console.error("Could not sign out.", error);
    setStatus(chatStatus, error.message || "Could not sign out. Please try again.", true);
    signoutButton.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollUpdates();
  }
});

async function initializeInbox() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      window.location.replace("./login.html");
      return;
    }
    currentUser = user;
    signedInUsername.textContent = user.username;
    profileLink.href = `./profile.html?user=${user.id}&from=inbox`;
    accountAvatar.textContent = user.username.slice(0, 1).toUpperCase();
    addAvatarPhoto(accountAvatar, user);
    await loadConversations();

    const response = await fetch("./api/updates?after_id=0", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) {
      throw getError(response, data, "Could not initialize message updates.");
    }
    latestUpdateMessageId = data.messages.reduce((maximum, message) => Math.max(maximum, message.id), 0);
    setStatus(chatStatus, "Connected");
    window.setInterval(pollUpdates, CHAT_POLL_INTERVAL_MS);
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not open your inbox.", error);
      setStatus(chatStatus, "Could not load your chats. Check that the Python server is running.", true);
    }
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.ready
    .then((registration) => {
      serviceWorkerRegistration = registration;
    })
    .catch((error) => {
      console.error("Could not access the service worker registration.", error);
    });
}
initializeInbox();
