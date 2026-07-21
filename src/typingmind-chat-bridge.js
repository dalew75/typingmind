(() => {
  'use strict';

  const DATABASE_NAME = 'keyval-store';
  const STORE_NAME = 'keyval';
  const FOLDERS_KEY = 'TM_useFolderList';
  const LOCK_NAME = 'typingmind-update-chat-websocket';
  const ROOT_FOLDER = 'root';
  const RECONNECT_MAX_MS = 30_000;

  let socket = null;
  let stopped = false;

  function emit(type, detail) {
    window.dispatchEvent(new CustomEvent(`typingmind-chat-bridge:${type}`, { detail }));
  }

  function randomId(prefix = '') {
    return `${prefix}${crypto.randomUUID()}`;
  }

  function normalizePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('payload must be an object');
    }

    const folder = value.folder == null || String(value.folder).trim() === ''
      ? ROOT_FOLDER
      : String(value.folder).trim();
    const chatId = typeof value.chatId === 'string' ? value.chatId.trim() : '';
    const message = typeof value.message === 'string' ? value.message : null;
    const role = value.role == null ? 'user' : value.role;

    if (!chatId) throw new TypeError('chatId must be a non-empty string');
    if (message == null) throw new TypeError('message must be a string');
    if (role !== 'user' && role !== 'assistant') {
      throw new TypeError('role must be "user" or "assistant"');
    }

    return { folder, chatId, message, role };
  }

  function readFolders() {
    try {
      const value = JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function resolveFolder(folderName) {
    if (folderName.toLowerCase() === ROOT_FOLDER) return null;

    const folders = readFolders();
    const existing = folders.find((folder) => folder && folder.title === folderName);
    if (existing) return existing.id;

    const now = new Date().toISOString();
    const folder = {
      id: randomId('fo-'),
      title: folderName,
      open: true,
      createdAt: now,
      updatedAt: now,
      syncedAt: null,
      order: folders.length,
    };
    localStorage.setItem(FOLDERS_KEY, JSON.stringify([...folders, folder]));
    return folder.id;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function updateChat(payload) {
    const input = normalizePayload(payload);
    const folderId = resolveFolder(input.folder);
    const database = await openDatabase();

    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const keysRequest = store.getAllKeys();
        const valuesRequest = store.getAll();
        let result;
        let keys;
        let values;

        const processRecords = () => {
          if (!keys || !values) return;
          const records = values.map((value, index) => ({ key: keys[index], value }));
          const existing = records.find(({ value }) => {
            if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) return false;
            const candidateFolderId = value.folderID || null;
            return value.chatTitle === input.chatId && candidateFolderId === folderId;
          });
          const chat = existing?.value;
          const now = new Date();
          const nextMessage = {
            role: input.role,
            uuid: randomId(),
            content: input.message,
            ...(input.role === 'assistant' ? { model: chat?.model || 'gpt-4o' } : {}),
          };

          if (chat) {
            result = {
              ...chat,
              messages: [...chat.messages, nextMessage],
              preview: input.message,
              updatedAt: now,
              lastMessageCreatedAt: now,
            };
          } else {
            const id = randomId('nats-');
            result = {
              id,
              chatID: id,
              chatTitle: input.chatId,
              model: 'gpt-4o',
              preview: input.message,
              messages: [nextMessage],
              createdAt: now,
              updatedAt: now,
              lastMessageCreatedAt: now,
              ...(folderId ? { folderID: folderId } : {}),
            };
          }

          store.put(result, existing?.key || `CHAT_${result.chatID}`);
        };

        keysRequest.onerror = () => reject(keysRequest.error);
        valuesRequest.onerror = () => reject(valuesRequest.error);
        keysRequest.onsuccess = () => {
          keys = keysRequest.result;
          processRecords();
        };
        valuesRequest.onsuccess = () => {
          values = valuesRequest.result;
          processRecords();
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('chat update transaction aborted'));
      });
    } finally {
      database.close();
    }
  }

  async function handleMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
      const chat = await updateChat(payload);
      emit('updated', { chatID: chat.chatID, chatTitle: chat.chatTitle });
    } catch (error) {
      console.error('TypingMind chat bridge rejected a message:', error);
      emit('error', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function connectUntilStopped(url) {
    let delay = 1_000;
    while (!stopped) {
      await new Promise((resolve) => {
        const nextSocket = new WebSocket(url);
        socket = nextSocket;
        nextSocket.addEventListener('open', () => {
          delay = 1_000;
          emit('connected', { url });
        });
        nextSocket.addEventListener('message', handleMessage);
        nextSocket.addEventListener('error', () => {
          emit('error', { message: `WebSocket connection failed: ${url}` });
        });
        nextSocket.addEventListener('close', () => {
          if (socket === nextSocket) socket = null;
          emit('disconnected', { url });
          resolve();
        }, { once: true });
      });
      if (!stopped) {
        await wait(delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    }
  }

  async function start() {
    const url = window.TYPINGMIND_BRIDGE_CONFIG?.url?.trim();
    if (!url) {
      console.warn('TypingMind chat bridge disabled: configure TYPINGMIND_BRIDGE_CONFIG.url');
      return;
    }

    stopped = false;
    if (navigator.locks?.request) {
      await navigator.locks.request(LOCK_NAME, () => connectUntilStopped(url));
    } else {
      await connectUntilStopped(url);
    }
  }

  function stop() {
    stopped = true;
    socket?.close(1000, 'page closing');
    socket = null;
  }

  window.TypingMindChatBridge = Object.freeze({ normalizePayload, updateChat, start, stop });
  window.addEventListener('pagehide', stop, { once: true });
  void start();
})();
