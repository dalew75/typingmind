# Repository Guidelines

## Project Overview

This repository distributes the **compiled static self-host build of TypingMind**, an offline-first browser UI for chatting with OpenAI, Claude, Gemini, custom, and local models. It is a deployment artifact, not the application source repository. Per `LICENSE.md`, compiled code may be deployed and used but not modified or redistributed.

## Architecture & Data Flow

- `npm run start` serves `src/`; `src/index.html` loads the prebuilt Next.js 14/Turbopack SPA from `src/_next/static/`.
- React hydrates the client UI. MobX stores hold application state; `localStorage`, IndexedDB (`idb-keyval`), and cookies persist chats, settings, and credentials.
- The browser calls model providers, plugins, MCP servers, license services, and optional TypingMind Cloud directly. This repository contains no application backend.
- Requests use browser async/streaming APIs and queued work. Runtime validation, translated UI errors/toasts, and Sentry are compiled into the bundles.
- Configuration is data-driven (model profiles, API keys, plugin settings); there is no dependency-injection container.
- `src/sw.js` provides the PWA/offline cache path. `src/openapi.yaml` describes the remote TypingMind Custom API, not a local server.
- `src/typingmind-chat-bridge.js` is a custom browser adapter: one tab holds a Web Lock, receives `update-chat` WebSocket messages, and appends them to `TM_useFolderList` in localStorage and `CHAT_<id>` records in IndexedDB. It never invokes a model; TypingMind reflects writes after reload.

Do not patch hashed/minified files in `src/_next/static/`; functional UI or business-logic changes require an upstream TypingMind build.

## Key Directories

- `src/` — deployable web root.
- `src/_next/static/` — generated JS, CSS, fonts, route manifests, and Turbopack runtime; treat as immutable.
- `src/assets/` — static provider, onboarding, and marketing assets.
- `src/lib/audio-recorder/` — vendored compiled browser audio-recorder libraries.

There are no upstream application source, test, script, CI, or server directories. The standalone `src/typingmind-chat-bridge.js` integration is maintained source.

## Development Commands

```bash
# Reproducible npm install (preferred because package-lock.json is present)
npm ci

# Serve src/ at http://localhost:3008
npm run start

# Yarn v1 alternatives
yarn install --frozen-lockfile
yarn start
```

`package.json` defines only `start`: `http-server ./src/ -p 3008`; use port **3008**. There are no build, test, lint, format, or type-check commands. Updates are delivered with `git pull`, followed by restarting/redeploying the static server.

## Code Conventions & Common Patterns

- Treat hashed TypingMind assets as generated release output. Custom integration code lives in readable, standalone files under `src/`.
- Do not hand-format, rename, de-minify, or refactor hashed bundles. Do not create a second convention around generated files.
- Preserve existing JSON/YAML/HTML structure when changing deployable metadata such as `src/manifest.json` or `src/openapi.yaml`.
- Keep secrets out of the repository. License keys, provider keys, model profiles, and plugin settings are supplied in the browser.
- Upstream architecture uses React/MobX state, browser persistence, streaming `fetch`, queues, translated errors/toasts, schema validation, and Sentry. These are architectural facts, not APIs available as editable source here.
- The bridge payload is `{ folder?, chatId, message, role? }`; `role` is `user` or `assistant`, and repeated deliveries append repeatedly. Keep this boundary validation explicit.
- No repository-level naming, formatting, error-handling, or test convention is configured. Avoid introducing tooling unless explicitly requested.

## Important Files

- `package.json` — local static-server command and sole direct development dependency.
- `package-lock.json`, `yarn.lock` — npm and Yarn v1 dependency locks; use one package manager consistently per change.
- `src/index.html` — SPA entry point.
- `src/404.html` — static-host fallback page.
- `src/sw.js` — service worker/offline behavior.
- `src/manifest.json` — PWA metadata.
- `src/openapi.yaml` — remote TypingMind Custom API description.
- `src/typingmind-bridge-config.js` — deployment-specific WebSocket bridge URL.
- `src/typingmind-chat-bridge.js` — `update-chat` validation, folder/chat persistence, reconnect, and single-tab ownership.
- `README.md` — deployment, setup, local-model, and update workflow.
- `LICENSE.md` — binding modification and redistribution restrictions.
- `ACKNOWLEDGEMENT.md` — informational upstream dependency inventory.

## Runtime/Tooling Preferences

- Use Node.js with npm by default; `http-server@14.1.1` requires Node.js 12 or newer. No exact Node version is pinned.
- Yarn v1 is also supported, but do not update both lockfiles through mixed package-manager operations in one change.
- Production needs only a static host pointed at `src/`; do not serve the repository root.
- Use HTTPS outside `localhost` so service workers, microphone access, and other secure-context features work.
- No Bun, TypeScript compiler, Next.js build toolchain, Docker, CI workflow, ESLint, Prettier, or EditorConfig is configured.

## Testing & QA

No automated tests, fixtures, mocks, coverage tooling, or CI checks exist. Validate deployment changes with a browser smoke test:

1. Run `npm ci` and `npm run start`.
2. Open `http://localhost:3008/` and confirm the SPA loads without failed static assets.
3. Exercise the affected browser path (for example, PWA metadata, offline behavior, or custom-model **Test** flow). For chat-bridge changes, send both `user` and `assistant` payloads through a WebSocket fixture, reload, and verify the folder/chat in the sidebar.
4. For non-localhost deployments, repeat over HTTPS.

Do not claim `npm test`, lint, coverage, or a source build passed; those commands are undefined in this repository.
