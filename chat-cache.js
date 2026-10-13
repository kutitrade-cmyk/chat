const CHAT_CACHE_DATABASE = "murmur-private-chat";
const CHAT_CACHE_VERSION = 1;
const CHAT_CACHE_STORE = "messages";

function openChatCache() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support local chat caching."));
      return;
    }

    const request = indexedDB.open(CHAT_CACHE_DATABASE, CHAT_CACHE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHAT_CACHE_STORE)) {
        const store = database.createObjectStore(CHAT_CACHE_STORE, {
          keyPath: ["userId", "conversationId", "id"]
        });
        store.createIndex("userConversation", ["userId", "conversationId"]);
        store.createIndex("user", "userId");
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("Could not open local chat storage.")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("Local chat storage is blocked by another browser tab.")), { once: true });
  });
}

async function readChatCache(userId, conversationId) {
  const database = await openChatCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHAT_CACHE_STORE, "readonly");
    const request = transaction.objectStore(CHAT_CACHE_STORE)
      .index("userConversation")
      .getAll(IDBKeyRange.only([userId, conversationId]));
    request.addEventListener("success", () => {
      resolve(request.result.sort((first, second) => first.id - second.id));
    }, { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("Could not read cached chat messages.")), { once: true });
    transaction.addEventListener("complete", () => database.close(), { once: true });
    transaction.addEventListener("abort", () => database.close(), { once: true });
  });
}

async function writeChatCache(userId, conversationId, messages) {
  if (!messages.length) {
    return;
  }
  const database = await openChatCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHAT_CACHE_STORE, "readwrite");
    const store = transaction.objectStore(CHAT_CACHE_STORE);
    for (const message of messages) {
      store.put({ ...message, userId, conversationId });
    }
    transaction.addEventListener("complete", () => {
      database.close();
      resolve();
    }, { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("Could not save cached chat messages.")), { once: true });
    transaction.addEventListener("abort", () => {
      database.close();
      reject(transaction.error || new Error("Could not save cached chat messages."));
    }, { once: true });
  });
}

async function clearChatCache(userId) {
  const database = await openChatCache();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHAT_CACHE_STORE, "readwrite");
    const request = transaction.objectStore(CHAT_CACHE_STORE).index("user").openKeyCursor(IDBKeyRange.only(userId));
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor) {
        transaction.objectStore(CHAT_CACHE_STORE).delete(cursor.primaryKey);
        cursor.continue();
      }
    });
    transaction.addEventListener("complete", () => {
      database.close();
      resolve();
    }, { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("Could not clear cached chat messages.")), { once: true });
    transaction.addEventListener("abort", () => {
      database.close();
      reject(transaction.error || new Error("Could not clear cached chat messages."));
    }, { once: true });
  });
}

window.MurmurChatCache = {
  clear: clearChatCache,
  read: readChatCache,
  write: writeChatCache
};
