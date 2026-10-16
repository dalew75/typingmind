(() => {
  'use strict';

  const MODELS_KEY = 'TM_useCustomModels';
  const LOCK_NAME = 'typingmind-model-websocket';
  const CHANNEL_NAME = 'typingmind-model-bridge';
  const BANNER_ID = 'typingmind-model-bridge-banner';
  const ID_PREFIX = 'nats-model-';
  const SOURCE = 'NATS';
  const RECONNECT_MAX_MS = 30_000;
  const OPTIONAL_FLAGS = [
    'pluginSupported',
    'visionSupported',
    'systemMessageSupported',
    'streamOutputSupported',
    'thinkingSupported',
    'promptCachingSupported',
  ];

  let socket = null;
  let stopped = false;
  let expectedSubject = null;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;

  function emit(type, detail) {
    window.dispatchEvent(new CustomEvent(`typingmind-model-bridge:${type}`, { detail }));
  }

  function optionalString(value, name) {
    if (value == null) return undefined;
    if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
    return value.trim() || undefined;
  }

  function requiredString(value, name) {
    const result = optionalString(value, name);
    if (!result) throw new TypeError(`${name} must be a non-empty string`);
    return result;
  }

  function normalizePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('payload must be an object');
    }

    const action = value.action == null ? 'upsert' : value.action;
    if (action !== 'upsert' && action !== 'remove') {
      throw new TypeError('action must be "upsert" or "remove"');
    }

    const id = requiredString(value.id, 'id');
    if (action === 'remove') return { action, id };

    const title = requiredString(value.title, 'title');
    const endpoint = requiredString(value.endpoint, 'endpoint');
    let endpointUrl;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      throw new TypeError('endpoint must be an absolute URL');
    }
    if (endpointUrl.protocol !== 'https:' && endpointUrl.protocol !== 'http:') {
      throw new TypeError('endpoint must use http or https');
    }
    const modelID = requiredString(value.modelID, 'modelID');

    let contextLength;
    if (value.contextLength != null) {
      contextLength = Number(value.contextLength);
      if (!Number.isInteger(contextLength) || contextLength <= 0) {
        throw new TypeError('contextLength must be a positive integer');
      }
    }

    const flags = {};
    for (const flag of OPTIONAL_FLAGS) {
      if (value[flag] == null) continue;
      if (typeof value[flag] !== 'boolean') throw new TypeError(`${flag} must be a boolean`);
      flags[flag] = value[flag];
    }

    return {
      action,
      id,
      title,
      endpoint,
      modelID,
      apiKey: optionalString(value.apiKey, 'apiKey'),
      description: optionalString(value.description, 'description'),
      contextLength,
      flags,
    };
  }

  function readModels() {
    try {
      const value = JSON.parse(localStorage.getItem(MODELS_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  // Ignores fields that change on every delivery, so redelivery does not re-prompt a reload.
  function fingerprint(model) {
    const { updatedAt, headerRows, ...rest } = model;
    return JSON.stringify({ ...rest, headerRows: (headerRows || []).map(({ key, value }) => [key, value]) });
  }

  function applyModelUpdate(payload) {
    const input = normalizePayload(payload);
    const storedId = `${ID_PREFIX}${input.id}`;
    const models = readModels();
    const index = models.findIndex((model) => model && model.id === storedId);
    const existing = index === -1 ? null : models[index];

    if (input.action === 'remove') {
      if (!existing) return { action: 'remove', id: input.id, title: null, changed: false };
      if (existing.source !== SOURCE) {
        throw new Error(`refusing to remove model "${storedId}": it was not created by the NATS bridge`);
      }
      localStorage.setItem(MODELS_KEY, JSON.stringify(models.filter((_, i) => i !== index)));
      return { action: 'remove', id: input.id, title: existing.title, changed: true };
    }

    if (existing && existing.source !== SOURCE) {
      throw new Error(`refusing to overwrite model "${storedId}": it was not created by the NATS bridge`);
    }

    const model = {
      pluginSupported: false,
      visionSupported: false,
      systemMessageSupported: true,
      streamOutputSupported: true,
      supportedParameters: ['temperature', 'topP', 'maxTokens', 'contextLimit'],
      bodyRows: [],
      ...existing,
      ...input.flags,
      id: storedId,
      source: SOURCE,
      title: input.title,
      description: input.description ?? existing?.description ?? '',
      endpoint: input.endpoint,
      modelID: input.modelID,
      apiType: 'openai',
      ...(input.contextLength ? { contextLength: input.contextLength } : {}),
      headerRows: input.apiKey
        ? [{ id: crypto.randomUUID(), key: 'Authorization', value: `Bearer ${input.apiKey}`, isAuthHeader: true }]
        : [],
      skipAPIKey: true,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existing && fingerprint(existing) === fingerprint(model)) {
      return { action: 'upsert', id: input.id, title: model.title, changed: false };
    }

    const next = [...models];
    if (existing) next[index] = model;
    else next.push(model);
    localStorage.setItem(MODELS_KEY, JSON.stringify(next));
    return { action: 'upsert', id: input.id, title: model.title, changed: true };
  }

  function describe(result) {
    return result.action === 'remove'
      ? `Model "${result.title}" was removed.`
      : `Model "${result.title}" is available.`;
  }

  function showReloadBanner(text) {
    if (!document.body) return;
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.setAttribute('role', 'status');
      banner.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'gap:12px', 'max-width:min(420px,calc(100vw - 32px))',
        'padding:10px 12px', 'border-radius:8px', 'background:#1f2937', 'color:#f9fafb',
        'font:14px/1.4 system-ui,sans-serif', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      ].join(';');

      const label = document.createElement('span');
      label.dataset.role = 'text';
      label.style.flex = '1';

      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload';
      reload.style.cssText = 'padding:4px 10px;border:0;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;font:inherit';
      reload.addEventListener('click', () => location.reload());

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.style.cssText = 'padding:0 4px;border:0;background:none;color:inherit;cursor:pointer;font:18px/1 system-ui,sans-serif';
      dismiss.addEventListener('click', () => banner.remove());

      banner.append(label, reload, dismiss);
      document.body.append(banner);
    }
    banner.querySelector('[data-role="text"]').textContent = `${text} Reload to update the model list.`;
  }

  function isBridgeAck(value) {
    return value && typeof value === 'object' && value.id == null && typeof value.subject === 'string'
      && ('success' in value || 'error' in value);
  }

  async function handleMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
      // Fan-out bridges deliver every NATS subject to every client, tagged with `_subject`.
      if (payload && typeof payload === 'object' && typeof payload._subject === 'string'
        && payload._subject !== expectedSubject) {
        return;
      }
      if (isBridgeAck(payload)) {
        console.debug('TypingMind model bridge ignored a bridge acknowledgement:', payload);
        return;
      }
      const result = applyModelUpdate(payload);
      emit('updated', result);
      if (!result.changed) return;
      showReloadBanner(describe(result));
      channel?.postMessage(result);
    } catch (error) {
      console.error('TypingMind model bridge rejected a message:', error);
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
    const url = window.TYPINGMIND_BRIDGE_CONFIG?.modelsUrl?.trim();
    if (!url) {
      console.warn('TypingMind model bridge disabled: configure TYPINGMIND_BRIDGE_CONFIG.modelsUrl');
      return;
    }

    // The bridge uses the URL path, including the leading slash, as the NATS subject.
    expectedSubject = new URL(url).pathname;
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

  channel?.addEventListener('message', (event) => {
    if (event.data?.title) showReloadBanner(describe(event.data));
  });

  window.TypingMindModelBridge = Object.freeze({ normalizePayload, applyModelUpdate, start, stop });
  window.addEventListener('pagehide', stop, { once: true });
  void start();
})();
