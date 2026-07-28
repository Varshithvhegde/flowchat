# FlowChat

A multi-user AI chat where the model responds with live HTML instead of markdown. Every reply can be a game, dashboard, animated background, interactive form, or a full UI redesign — running directly in the browser.

**Live demo:** https://flowchat-public.varshithvh.workers.dev

![FlowChat screenshot](https://raw.githubusercontent.com/Varshithvhegde/flowchat/main/docs/screenshot.png)

---

## What it does

- The AI responds with raw HTML, CSS, and JS — not markdown
- Updates are injected into the page using a streaming partial-update protocol
- Multiple users on the same URL see updates in real time over WebSockets
- The AI can target specific parts of the page independently (update one game cell, not the whole board)
- Style themes, background animations, and full interface redesigns all work via CSS marker injection
- Each chat room is a Cloudflare Durable Object with its own SQLite storage and WebSocket connections

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| State + WebSockets | Cloudflare Durable Objects |
| Storage | SQLite (via Durable Object storage) |
| Auth (optional) | better-auth |
| AI Model | Inception Mercury-2 / Gemini / Cloudflare AI Gateway |
| Language | TypeScript |

---

## Running locally

### Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is fine)
- An API key for at least one model provider

### 1. Clone and install

```bash
git clone https://github.com/Varshithvhegde/flowchat.git
cd flowchat
npm install
```

### 2. Create your `.env` file

Copy the example and fill in your credentials:

```bash
cp .env.example .env
```

**Minimum config to run locally (pick one model provider):**

Option A — Inception Mercury-2 (recommended):
```
MODEL_PROVIDER=inception-direct
INCEPTION_API_KEY=your_key_here
INCEPTION_MODEL=mercury-2
INCEPTION_REASONING_EFFORT=medium
INCEPTION_MAX_TOKENS=8192
```

Option B — Gemini (simplest, has a free tier):
```
MODEL_PROVIDER=gemini-direct
GEMINI_API_KEY=your_key_here
```

Option C — Cloudflare AI Gateway (requires Cloudflare account with AI Gateway enabled):
```
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
CLOUDFLARE_AI_GATEWAY_ID=default
```

### 3. Run the database migration

```bash
npm run db:migrate:local
```

### 4. Start the dev server

```bash
npm run dev
```

Open http://localhost:8787 in your browser.

To test real-time multi-user sync, open the same chat URL in two different browser windows. Both will receive AI responses simultaneously.

### Storing secrets securely (optional)

If you do not want your API keys in a `.env` file visible to AI coding tools, you can store them in the macOS keychain instead:

```bash
security add-generic-password -a "frontclaw" -s "INCEPTION_API_KEY" -w "your_key"
security add-generic-password -a "frontclaw" -s "CLOUDFLARE_API_TOKEN" -w "your_token"
security add-generic-password -a "frontclaw" -s "CLOUDFLARE_ACCOUNT_ID" -w "your_id"
```

Then run:

```bash
npm run dev:secure
```

---

## Deploying to Cloudflare (free tier)

### 1. Log in to Wrangler

```bash
npx wrangler login
```

### 2. Create a D1 database

```bash
npx wrangler d1 create flowchat-auth-public
```

Copy the `database_id` from the output and update `wrangler.jsonc` under `env.public.d1_databases`.

### 3. Run the remote migration

```bash
npm run db:migrate:public
# or manually:
npx wrangler d1 migrations apply flowchat-auth-public --env public --remote
```

### 4. Set your secrets

```bash
echo "inception-direct" | npx wrangler secret put MODEL_PROVIDER --env public
echo "mercury-2"        | npx wrangler secret put INCEPTION_MODEL --env public
echo "your_key_here"    | npx wrangler secret put INCEPTION_API_KEY --env public
```

### 5. Deploy

```bash
npx wrangler deploy --env public
```

Wrangler will print a `workers.dev` URL. That URL is immediately public and shareable.

To redeploy after any code change:

```bash
npx wrangler deploy --env public
```

---

## Authentication (optional)

Authentication is disabled by default. Anyone with the link can chat.

To enable it, set `AUTH_PROVIDERS` in your environment and configure `BETTER_AUTH_SECRET`:

```bash
npx wrangler secret put BETTER_AUTH_SECRET --env public
```

Supported providers: Google, GitHub, email and password.

Roles: `admin`, `dev`, `chat`, `view`, `blocked`. The first user to sign up becomes admin.

Admin panel is at `/admin`.

---

## How the protocol works

The AI responds using a delimiter-based protocol rather than plain text:

```
PpqUtcLGQdYN4oqc:BODY_START
<template for="/chat/append-message">
  <div class="message message-user" data-client-id="1">Hello</div>
  <div class="message message-agent">Hi there</div>
  <?marker name="/chat/append-message">
</template>
PpqUtcLGQdYN4oqc:BODY_END
```

The `for` attribute targets a named marker in the DOM. The client runtime replaces the marker with the template content. A single response can contain multiple messages separated by `PpqUtcLGQdYN4oqc:SPLIT_MESSAGE`, routed to different clients using server-side props that are stripped before reaching the browser.

Available DOM targets:
- `/chat/append-message` — append to the chat list
- `/page/background` — render behind chat messages (animations, images)
- `/style/layout-overrides` — override layout CSS
- `/style/chat-overrides` — override chat and message CSS
- `/style/prompt-box-overrides` — override the input area

---

## Project structure

```
flowchat/
├── src/
│   ├── index.ts          # Worker entry point, Durable Object, all routing
│   ├── env.ts            # Environment type definitions
│   ├── debug.ts          # Debug view renderer
│   ├── getPrompt.ts      # System prompt builder
│   ├── initialPrompt.md  # AI system prompt
│   ├── app.html          # Chat UI template with DOM markers
│   ├── app.css           # In-chat component styles
│   ├── page.css          # App shell styles and design tokens
│   └── auth/
│       ├── email.ts      # Verification email sender
│       ├── profile.ts    # User profile upsert
│       ├── providers.ts  # Auth provider config helpers
│       ├── roles.ts      # Role definitions and permission checks
│       ├── routes.ts     # Auth route handlers and page renderers
│       └── server.ts     # better-auth instance factory
├── migrations/
│   ├── 0001_better_auth.sql
│   └── 0002_user_roles.sql
├── scripts/
│   └── dev-secure.sh     # Dev server with secrets from macOS keychain
├── wrangler.jsonc         # Cloudflare Workers configuration
└── .env.example          # Environment variable template
```

---

## Available scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start local dev server on `0.0.0.0:8787` |
| `npm run dev:secure` | Start dev server with secrets from macOS keychain |
| `npm run dev:tunnel` | Start dev server with a public tunnel URL |
| `npm run db:migrate:local` | Apply migrations to local D1 |
| `npm run db:migrate:alpha` | Apply migrations to alpha D1 (remote) |
| `npm run db:migrate:production` | Apply migrations to production D1 (remote) |
| `npm run deploy:alpha` | Deploy to alpha environment |
| `npm run deploy:production` | Deploy to production environment |
| `npx wrangler deploy --env public` | Deploy to public workers.dev URL |
| `npm run cf-typegen` | Regenerate Cloudflare type definitions |

---

## Debug view

Every chat has a debug view at `/c/{chatId}/debug` showing the full LLM message history in the format the model receives it. Useful for understanding what the model sees and debugging protocol output.

The debug view has a pretty mode that syntax-highlights the protocol delimiters and body HTML, and a raw JSON mode.

Clear the chat history from the debug view to reset the DO and system prompt.

---

## License

MIT
