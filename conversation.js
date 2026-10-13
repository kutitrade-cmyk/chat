const conversationTitle = document.querySelector("#conversation-title");
const threadAvatar = document.querySelector("#thread-avatar");
const chatHistory = document.querySelector("#chat-history");
const chatEmpty = document.querySelector("#chat-empty");
const chatForm = document.querySelector("#chat-form");
const chatMessageInput = document.querySelector("#chat-message");
const chatImageInput = document.querySelector("#chat-image");
const voiceNoteButton = document.querySelector("#voice-note-button");
const attachmentPreview = document.querySelector("#chat-attachment-preview");
const voiceRecordingStatus = document.querySelector("#voice-recording-status");
const sendMessageButton = document.querySelector("#send-message-button");
const loadOlderButton = document.querySelector("#load-older-button");
const chatStatus = document.querySelector("#chat-status");
const backToChatsButton = document.querySelector("#back-to-chats-button");
const threadProfileLink = document.querySelector("#thread-profile-link");

const CHAT_PAGE_SIZE = 50;
const CHAT_POLL_INTERVAL_MS = 3000;
const MAX_IMAGE_SIZE = 200 * 1024 * 1024;
const MAX_VOICE_NOTE_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_NOTE_DURATION_MS = 3 * 60 * 1000;
const VOICE_NOTE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4"
];
const renderedMessages = new Map();
const visualViewport = window.visualViewport;
let currentUser;
let conversationId;
let latestUpdateMessageId = 0;
let oldestMessageId;
let isPolling = false;
let isLoadingOlderMessages = false;
let voiceRecorder;
let voiceStream;
let voiceChunks = [];
let voiceRecordingStartedAt = 0;
let voiceRecordingTimer;

function updateChatViewportHeight() {
  const height = visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--chat-viewport-height", `${height}px`);
}

updateChatViewportHeight();
visualViewport?.addEventListener("resize", updateChatViewportHeight);
window.addEventListener("resize", updateChatViewportHeight);
window.addEventListener("orientationchange", updateChatViewportHeight);

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
  if (message.audio_mime) {
    article.classList.add("chat-message-voice");
  }
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
  if (message.audio_mime) {
    article.append(createVoiceNotePlayer(message));
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

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function createVoiceNotePlayer(message) {
  const player = document.createElement("div");
  player.className = "voice-note-player";

  const audio = document.createElement("audio");
  audio.preload = "none";
  audio.src = `./api/conversations/${conversationId}/audio/${message.id}`;
  audio.setAttribute("aria-label", `Voice note from ${message.sender}`);

  const playButton = document.createElement("button");
  playButton.className = "voice-note-play-button";
  playButton.type = "button";
  playButton.setAttribute("aria-label", "Play voice note");
  playButton.innerHTML = '<svg class="voice-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 12 7-12 7V5Z" /></svg><svg class="voice-pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm7 0h4v14h-4z" /></svg>';

  const trackColumn = document.createElement("div");
  trackColumn.className = "voice-note-track-column";
  const waveform = document.createElement("div");
  waveform.className = "voice-note-waveform";
  waveform.setAttribute("role", "slider");
  waveform.setAttribute("tabindex", "0");
  waveform.setAttribute("aria-label", `Seek voice note from ${message.sender}`);
  waveform.setAttribute("aria-valuemin", "0");
  waveform.setAttribute("aria-valuemax", "0");
  waveform.setAttribute("aria-valuenow", "0");
  waveform.setAttribute("aria-valuetext", "0:00 of 0:00");
  const bars = [];

  let seed = (message.id * 2654435761) >>> 0;
  for (let index = 0; index < 36; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const bar = document.createElement("span");
    bar.style.setProperty("--wave-height", `${18 + seed % 75}%`);
    waveform.append(bar);
    bars.push(bar);
  }

  const timing = document.createElement("div");
  timing.className = "voice-note-timing";
  const elapsed = document.createElement("span");
  elapsed.textContent = "0:00";
  const duration = document.createElement("span");
  duration.textContent = "0:00";
  timing.append(elapsed, duration);
  trackColumn.append(waveform, timing);
  player.append(playButton, trackColumn, audio);

  const updateProgress = () => {
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const total = Number.isFinite(audio.duration) ? audio.duration : 0;
    const progress = total > 0 ? Math.min(100, currentTime / total * 100) : 0;
    waveform.setAttribute("aria-valuemax", String(Math.floor(total)));
    waveform.setAttribute("aria-valuenow", String(Math.floor(currentTime)));
    waveform.setAttribute("aria-valuetext", `${formatAudioTime(currentTime)} of ${formatAudioTime(total)}`);
    bars.forEach((bar, index) => {
      bar.classList.toggle("is-played", index / bars.length < progress / 100);
    });
    elapsed.textContent = formatAudioTime(currentTime);
    duration.textContent = formatAudioTime(total);
  };

  const pauseOtherVoiceNotes = () => {
    document.querySelectorAll(".voice-note-player audio").forEach((otherAudio) => {
      if (otherAudio !== audio && !otherAudio.paused) {
        otherAudio.pause();
      }
    });
  };

  playButton.addEventListener("click", async () => {
    if (audio.paused) {
      pauseOtherVoiceNotes();
      try {
        await audio.play();
      } catch (error) {
        console.error("Could not play the voice note.", error);
        setStatus("Could not play this voice note. Check your connection and try again.", true);
      }
    } else {
      audio.pause();
    }
  });

  const seekToPointer = (event) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      return;
    }
    const bounds = waveform.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    audio.currentTime = ratio * audio.duration;
    updateProgress();
  };

  waveform.addEventListener("click", seekToPointer);
  waveform.addEventListener("keydown", (event) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      return;
    }
    const step = event.shiftKey ? 10 : 5;
    if (event.key === "ArrowRight") {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + step);
    } else if (event.key === "ArrowLeft") {
      audio.currentTime = Math.max(0, audio.currentTime - step);
    } else if (event.key === "Home") {
      audio.currentTime = 0;
    } else if (event.key === "End") {
      audio.currentTime = audio.duration;
    } else {
      return;
    }
    event.preventDefault();
    updateProgress();
  });

  audio.addEventListener("loadedmetadata", updateProgress);
  audio.addEventListener("durationchange", updateProgress);
  audio.addEventListener("timeupdate", updateProgress);
  audio.addEventListener("play", () => {
    player.classList.add("is-playing");
    playButton.setAttribute("aria-label", "Pause voice note");
    setStatus("Connected");
  });
  audio.addEventListener("pause", () => {
    player.classList.remove("is-playing");
    playButton.setAttribute("aria-label", "Play voice note");
  });
  audio.addEventListener("ended", () => {
    audio.currentTime = 0;
    updateProgress();
  });
  audio.addEventListener("error", () => {
    if (audio.error) {
      setStatus("Could not load this voice note. Check your connection and try again.", true);
    }
  });

  return player;
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

async function cacheMessages(messages) {
  try {
    await window.MurmurChatCache.write(currentUser.id, conversationId, messages);
  } catch (error) {
    console.error("Could not save private chat history on this device.", error);
  }
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
  await cacheMessages(messages);
  updatePagination(messages);
  if (messages.length > 0 && markAsRead) {
    markRead(messages[messages.length - 1].id).catch((error) => {
      console.error("Could not mark conversation messages as read.", error);
    });
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
    await cacheMessages(messages);
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
    body: message.body || (message.audio_mime ? "You received a voice note." : "You received an image."),
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
    await cacheMessages([data.message]);
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
    chatMessageInput.disabled = false;
    chatImageInput.disabled = false;
    voiceNoteButton.disabled = false;
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

function stopVoiceRecording() {
  if (voiceRecorder && voiceRecorder.state === "recording") {
    voiceRecorder.stop();
  }
}

function formatRecordingTime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function uploadVoiceNote(blob) {
  if (!blob.size || blob.size > MAX_VOICE_NOTE_SIZE) {
    sendMessageButton.disabled = false;
    chatMessageInput.disabled = false;
    chatImageInput.disabled = false;
    voiceNoteButton.disabled = false;
    setStatus("Voice notes must be between 1 byte and 10 MB.", true);
    return;
  }

  sendMessageButton.disabled = true;
  voiceNoteButton.disabled = true;
  setStatus("Sending voice note…");
  try {
    const contentType = blob.type.split(";")[0];
    const data = await requestJson(`./api/conversations/${conversationId}/audio`, {
      method: "POST",
      headers: { "Content-Type": contentType, Accept: "application/json" },
      body: blob
    });
    renderMessage(data.message);
    await cacheMessages([data.message]);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    setStatus("Connected");
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else {
      console.error("Could not send the voice note.", error);
      setStatus(error.message || "Your voice note could not be sent. Please try again.", true);
    }
  } finally {
    sendMessageButton.disabled = false;
    chatMessageInput.disabled = false;
    chatImageInput.disabled = false;
    voiceNoteButton.disabled = false;
  }
}

voiceNoteButton.addEventListener("click", async () => {
  if (voiceRecorder?.state === "recording") {
    stopVoiceRecording();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
    setStatus("This browser does not support recording voice notes.", true);
    return;
  }
  if (chatMessageInput.value.trim() || chatImageInput.files.length) {
    setStatus("Send or clear your current message before recording a voice note.", true);
    return;
  }

  voiceNoteButton.disabled = true;
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = typeof MediaRecorder.isTypeSupported === "function"
      ? VOICE_NOTE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
      : undefined;
    voiceRecorder = mimeType
      ? new MediaRecorder(voiceStream, { mimeType })
      : new MediaRecorder(voiceStream);
    voiceChunks = [];
    voiceRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        voiceChunks.push(event.data);
      }
    });
    voiceRecorder.addEventListener("stop", () => {
      window.clearInterval(voiceRecordingTimer);
      voiceStream.getTracks().forEach((track) => track.stop());
      voiceStream = undefined;
      voiceNoteButton.classList.remove("is-recording");
      voiceNoteButton.setAttribute("aria-label", "Record a voice note");
      voiceNoteButton.title = "Record a voice note";
      voiceRecordingStatus.hidden = true;
      voiceRecordingStatus.textContent = "";
      const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || mimeType });
      voiceChunks = [];
      uploadVoiceNote(blob);
    }, { once: true });
    voiceRecorder.start();
    voiceRecordingStartedAt = Date.now();
    voiceNoteButton.classList.add("is-recording");
    voiceNoteButton.setAttribute("aria-label", "Stop and send voice note");
    voiceNoteButton.title = "Stop and send voice note";
    chatMessageInput.disabled = true;
    chatImageInput.disabled = true;
    sendMessageButton.disabled = true;
    voiceRecordingStatus.hidden = false;
    const updateRecordingStatus = () => {
      const elapsed = Date.now() - voiceRecordingStartedAt;
      voiceRecordingStatus.textContent = `Recording ${formatRecordingTime(elapsed)} · tap stop to send`;
      if (elapsed >= MAX_VOICE_NOTE_DURATION_MS) {
        stopVoiceRecording();
      }
    };
    updateRecordingStatus();
    voiceRecordingTimer = window.setInterval(updateRecordingStatus, 1000);
  } catch (error) {
    console.error("Could not start voice-note recording.", error);
    voiceStream?.getTracks().forEach((track) => track.stop());
    voiceStream = undefined;
    setStatus(error.name === "NotAllowedError"
      ? "Microphone access was denied. Allow it in your browser settings to record a voice note."
      : "Could not start recording. Check your microphone and try again.", true);
  } finally {
    voiceNoteButton.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollUpdates();
  }
});

async function initializeConversation() {
  try {
    const conversationIdFromUrl = Number(new URLSearchParams(window.location.search).get("conversation"));
    if (!Number.isInteger(conversationIdFromUrl) || conversationIdFromUrl < 1) {
      window.location.replace("./index.html");
      return;
    }
    conversationId = conversationIdFromUrl;

    const [userData, conversationsData] = await Promise.all([
      requestJson("./api/me", { headers: { Accept: "application/json" } }),
      requestJson("./api/conversations", { headers: { Accept: "application/json" } })
    ]);
    if (!userData.user) {
      window.location.replace("./login.html");
      return;
    }
    currentUser = userData.user;

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

    try {
      const cachedMessages = await window.MurmurChatCache.read(currentUser.id, conversationId);
      for (const message of cachedMessages) {
        renderMessage(message);
      }
      if (cachedMessages.length > 0) {
        updatePagination(cachedMessages);
        chatHistory.scrollTop = chatHistory.scrollHeight;
        setStatus("Loading the latest messages…");
      }
    } catch (error) {
      console.error("Could not read private chat history saved on this device.", error);
    }

    const [updates] = await Promise.all([
      requestJson("./api/updates?after_id=0", { headers: { Accept: "application/json" } }),
      loadLatestMessages()
    ]);
    latestUpdateMessageId = updates.messages.reduce(
      (maximum, message) => Math.max(maximum, message.id),
      0
    );
    setStatus("Connected");
    window.setInterval(pollUpdates, CHAT_POLL_INTERVAL_MS);
  } catch (error) {
    if (error.status === 401) {
      window.location.replace("./login.html");
    } else if (error.status === 404) {
      window.location.replace("./index.html");
    } else {
      console.error("Could not open this conversation.", error);
      if (renderedMessages.size > 0) {
        setStatus("Offline — showing chat history saved on this device.", true);
      } else {
        setStatus("Could not load this conversation. Check that the Python server is running.", true);
      }
    }
  }
}

initializeConversation();
