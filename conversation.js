const conversationTitle = document.querySelector("#conversation-title");
const threadAvatar = document.querySelector("#thread-avatar");
const chatHistory = document.querySelector("#chat-history");
const chatEmpty = document.querySelector("#chat-empty");
const chatForm = document.querySelector("#chat-form");
const chatMessageInput = document.querySelector("#chat-message");
const chatImageInput = document.querySelector("#chat-image");
const attachmentPreview = document.querySelector("#chat-attachment-preview");
const sendMessageButton = document.querySelector("#send-message-button");
const loadOlderButton = document.querySelector("#load-older-button");
const chatStatus = document.querySelector("#chat-status");
const backToChatsButton = document.querySelector("#back-to-chats-button");
const threadProfileLink = document.querySelector("#thread-profile-link");

const CHAT_PAGE_SIZE = 50;
const CHAT_POLL_INTERVAL_MS = 3000;
const MAX_IMAGE_SIZE = 200 * 1024 * 1024;
const renderedMessages = new Map();
let currentUser;
let conversationId;
let latestUpdateMessageId = 0;
let oldestMessageId;
let isPolling = false;
let isLoadingOlderMessages = false;

function setStatus(message, isError = false) {
  chatStatus.textContent = message;
  chatStatus.classList.toggle("status-error", isError);
}

function getError(response, data, fallback) {
  const error = new Error(data.error || fallback);
  error.status = response.status;
  return error;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw getError(response, data, "The request could not be completed.");
  }
  return data;
}

function updateReceipt(message) {
  const article = renderedMessages.get(message.id);
  if (!article || message.user_id !== currentUser.id || typeof message.read_by_recipient !== "boolean") {
    return;
  }
  const receipt = article.querySelector(".chat-message-receipt");
  if (receipt) {
    receipt.textContent = message.read_by_recipient ? "Read" : "Sent";
    receipt.classList.toggle("chat-message-receipt-read", message.read_by_recipient);
  }
}

function renderMessage(message, prepend = false) {
  if (renderedMessages.has(message.id)) {
    updateReceipt(message);
    return;
  }

  const article = document.createElement("article");
  const isOwnMessage = message.user_id === currentUser.id;
  article.className = isOwnMessage ? "chat-message chat-message-own" : "chat-message";
  article.dataset.messageId = String(message.id);

  const details = document.createElement("div");
  details.className = "chat-message-details";
  const sender = document.createElement("span");
  sender.className = "chat-message-sender";
  sender.textContent = message.sender;
  const time = document.createElement("time");
  time.className = "chat-message-time";
  time.dateTime = message.created_at;
  const timestamp = new Date(message.created_at);
  time.textContent = Number.isNaN(timestamp.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
  details.append(sender, time);

  const body = document.createElement("p");
  body.className = "chat-message-body";
  body.textContent = message.body;
  article.append(details);

  if (message.image_mime) {
    const imageLink = document.createElement("a");
    imageLink.className = "chat-message-image-link";
    imageLink.href = `./api/conversations/${conversationId}/images/${message.id}`;
    imageLink.target = "_blank";
    imageLink.rel = "noreferrer";
    const image = document.createElement("img");
    image.className = "chat-message-image";
    image.src = imageLink.href;
    image.alt = `Image sent by ${message.sender}`;
    image.loading = "lazy";
    imageLink.append(image);
    article.append(imageLink);
  }
  if (message.body) {
    article.append(body);
  }

  if (isOwnMessage) {
    const receipt = document.createElement("span");
    receipt.className = "chat-message-receipt";
    article.append(receipt);
  }
  updateReceiptAfterAppend(article, message);
  chatEmpty.hidden = true;
  if (prepend) {
    chatHistory.prepend(article);
  } else {
    chatHistory.append(article);
  }
  renderedMessages.set(message.id, article);
}

function updateReceiptAfterAppend(article, message) {
  if (message.user_id !== currentUser.id) {
    return;
  }
  const receipt = article.querySelector(".chat-message-receipt");
  const isRead = message.read_by_recipient === true;
  receipt.textContent = isRead ? "Read" : "Sent";
  receipt.classList.toggle("chat-message-receipt-read", isRead);
}

function resetHistory() {
  chatHistory.querySelectorAll(".chat-message").forEach((message) => message.remove());
  renderedMessages.clear();
  oldestMessageId = undefined;
  loadOlderButton.hidden = true;
  chatEmpty.hidden = false;
}

async function fetchHistory(parameters = {}) {
  const query = new URLSearchParams({ limit: String(CHAT_PAGE_SIZE) });
  for (const [key, value] of Object.entries(parameters)) {
    query.set(key, String(value));
  }
  const data = await requestJson(`./api/conversations/${conversationId}/messages?${query.toString()}`, {
    headers: { Accept: "application/json" }
  });
  return data.messages;
}

function updatePagination(messages) {
  if (messages.length > 0) {
    oldestMessageId = Math.min(oldestMessageId ?? Infinity, messages[0].id);
  }
  loadOlderButton.hidden = !oldestMessageId || messages.length < CHAT_PAGE_SIZE;
}

async function markRead(messageId) {
  await requestJson(`./api/conversations/${conversationId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message_id: messageId })
  });
}

async function loadLatestMessages(markAsRead = !document.hidden) {
  const messages = await fetchHistory();
  for (const message of messages) {
    renderMessage(message);
  }
  updatePagination(messages);
  if (messages.length > 0 && markAsRead) {
    await markRead(messages[messages.length - 1].id);
  }
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return messages;
}

async function loadOlderMessages() {
  if (!oldestMessageId || isLoadingOlderMessages) {
    return;
  }
  isLoadingOlderMessages = true;
  loadOlderButton.disabled = true;
  const previousScrollHeight = chatHistory.scrollHeight;
  const previousScrollTop = chatHistory.scrollTop;
  try {
    const messages = await fetchHistory({ before_id: oldestMessageId });
    for (const message of messages) {
      renderMessage(message, true);
    }
    updatePagination(messages);
    chatHistory.scrollTop = previousScrollTop + chatHistory.scrollHeight - previousScrollHeight;
  } catch (error) {
    console.error("Could not load earlier chat messages.", error);
    setStatus("Could not load earlier messages. Please try again.", true);
  } finally {
    isLoadingOlderMessages = false;
    loadOlderButton.disabled = false;
  }
}

async function showIncomingNotification(message) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(`New message from ${message.sender}`, {
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
    const data = await requestJson(`./api/updates?after_id=${latestUpdateMessageId}`, {
      headers: { Accept: "application/json" }
    });
    for (const message of data.messages) {
      latestUpdateMessageId = Math.max(latestUpdateMessageId, message.id);
      if (message.user_id !== currentUser.id && document.hidden) {
        try {
          await showIncomingNotification(message);
        } catch (error) {
          console.error("Could not show a notification for the new chat message.", error);
        }
      }
    }

    const messages = await loadLatestMessages(!document.hidden);
    if (messages.some((message) => message.conversation_id === conversationId && message.user_id !== currentUser.id)) {
      setStatus("Connected");
    }
    setStatus("Connected");
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not refresh conversation history.", error);
      setStatus("Reconnecting to chat…", true);
    }
  } finally {
    isPolling = false;
  }
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = chatMessageInput.value.trim();
  const image = chatImageInput.files[0];
  if ((!body && !image) || sendMessageButton.disabled || !conversationId) {
    return;
  }
  if (image && (image.size < 1 || image.size > MAX_IMAGE_SIZE)) {
    setStatus("Choose a non-empty image no larger than 200 MB.", true);
    return;
  }
  sendMessageButton.disabled = true;
  try {
    let data;
    if (image) {
      setStatus("Uploading image…");
      const query = new URLSearchParams();
      if (body) {
        query.set("caption", body);
      }
      data = await requestJson(
        `./api/conversations/${conversationId}/images?${query.toString()}`,
        {
          method: "POST",
          headers: { "Content-Type": image.type, Accept: "application/json" },
          body: image
        }
      );
      chatImageInput.value = "";
      attachmentPreview.hidden = true;
      attachmentPreview.textContent = "";
    } else {
      setStatus("Sending…");
      data = await requestJson(`./api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ body })
      });
    }
    chatMessageInput.value = "";
    renderMessage(data.message);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    setStatus("Connected");
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not send the chat message.", error);
      setStatus(error.message || "Your message could not be sent. Please try again.", true);
    }
  } finally {
    sendMessageButton.disabled = false;
    chatMessageInput.focus();
  }
});

chatImageInput.addEventListener("change", () => {
  const image = chatImageInput.files[0];
  if (!image) {
    attachmentPreview.hidden = true;
    attachmentPreview.textContent = "";
    return;
  }
  if (image.size < 1 || image.size > MAX_IMAGE_SIZE) {
    chatImageInput.value = "";
    attachmentPreview.hidden = true;
    setStatus("Choose a non-empty image no larger than 200 MB.", true);
    return;
  }
  attachmentPreview.textContent = `${image.name} · ${formatFileSize(image.size)}`;
  attachmentPreview.hidden = false;
  setStatus("");
});

function formatFileSize(size) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

loadOlderButton.addEventListener("click", loadOlderMessages);
backToChatsButton.addEventListener("click", () => {
  window.location.href = "./index.html";
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollUpdates();
  }
});

async function initializeConversation() {
  try {
    const userData = await requestJson("./api/me", { headers: { Accept: "application/json" } });
    if (!userData.user) {
      window.location.replace("./login.html");
      return;
    }
    currentUser = userData.user;

    conversationId = Number(new URLSearchParams(window.location.search).get("conversation"));
    if (!Number.isInteger(conversationId) || conversationId < 1) {
      window.location.replace("./index.html");
      return;
    }

    const conversationsData = await requestJson("./api/conversations", {
      headers: { Accept: "application/json" }
    });
    const conversation = conversationsData.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      window.location.replace("./index.html");
      return;
    }
    threadProfileLink.href = `./profile.html?user=${conversation.user_id}&from=conversation&conversation=${conversationId}`;
    conversationTitle.textContent = conversation.username;
    threadAvatar.textContent = conversation.username.slice(0, 1).toUpperCase();
    if (conversation.has_avatar) {
      const avatar = new Image();
      avatar.className = "avatar-photo";
      avatar.alt = "";
      avatar.src = `./api/users/${conversation.user_id}/avatar`;
      avatar.addEventListener("error", () => avatar.remove());
      threadAvatar.append(avatar);
    }

    const updates = await requestJson("./api/updates?after_id=0", {
      headers: { Accept: "application/json" }
    });
    latestUpdateMessageId = updates.messages.reduce(
      (maximum, message) => Math.max(maximum, message.id),
      0
    );
    resetHistory();
    await loadLatestMessages();
    setStatus("Connected");
    window.setInterval(pollUpdates, CHAT_POLL_INTERVAL_MS);
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else if (error.status === 404) {
      window.location.replace("./index.html");
    } else {
      console.error("Could not open this conversation.", error);
      setStatus("Could not load this conversation. Check that the Python server is running.", true);
    }
  }
}

initializeConversation();
