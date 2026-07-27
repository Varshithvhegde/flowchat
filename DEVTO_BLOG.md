---
title: I Built an AI Chat Where the AI Responds With Live HTML Instead of Text
published: true
description: FlowChat is a multi-user AI chat app where the LLM generates real HTML, CSS, and JavaScript on every response. Games, dashboards, animations, themed UIs — all running live in the browser.
tags: webdev, cloudflare, ai, javascript
cover_image: [SCREENSHOT: Full app with Barbie theme + Tic Tac Toe game running in chat]
---

Most AI chat apps work the same way. You type something, the model returns markdown, the UI renders it as formatted text. That is fine for answers. It is boring for everything else.

What if the AI could respond with a working Tic Tac Toe board you could click? Or a live data dashboard with animated charts? Or redesign the entire interface while you watch?

That is what I built. I call it **FlowChat**.

{% embed https://flowchat-public.varshithvh.workers.dev %}

---

## What FlowChat Actually Does

Instead of returning markdown, the AI returns raw HTML. That HTML gets injected directly into the page using a custom streaming protocol built on top of the browser's native template system.

So when you say "build me a Tic Tac Toe game", you don't get a code block. You get a playable game, right there in the chat.

When you say "make it Barbie themed", the AI sends CSS overrides and the whole interface transforms. When you say "add a starfield in the background", an animated canvas fills the chat viewport behind your messages.

The AI literally rebuilds the UI from its responses.

[IMAGE: GIF or screenshot of Tic Tac Toe running in the chat]

[IMAGE: Screenshot of Barbie theme applied to full interface]

---

## The Tech Stack

FlowChat runs entirely on Cloudflare's edge infrastructure. No traditional server, no Node.js backend, no database in the usual sense.

**Cloudflare Workers** handles every HTTP request and runs the TypeScript code. Think of it as serverless but genuinely fast, running within milliseconds of any user in the world.

**Cloudflare Durable Objects** is the really interesting piece. Each chat room is a single Durable Object: a stateful, single-threaded Actor with its own SQLite database, its own WebSocket connections, and its own LLM queue. When you open a chat, you are connecting to a DO. When your friend opens the same URL, they connect to the same DO. That is how multi-user sync works with zero coordination overhead.

**Hibernatable WebSockets** keep connections alive efficiently. The DO sleeps between messages and wakes up when a client sends something. Cloudflare handles the ping/pong automatically.

**better-auth** provides optional authentication with Google, GitHub, and email/password. If you don't configure it, the app is open to everyone.

**Inception Labs Mercury-2** is the model powering the responses. It is a diffusion-based language model, which means it generates tokens in a very different way to typical autoregressive models. The practical effect: it feels fast. Responses stream in quickly and the model seems to genuinely understand the HTML output format.

[IMAGE: Wrangler terminal showing bindings on deploy]

---

## The Protocol

This was the most fun part to design. The AI can't just dump raw HTML into a response stream because a single response might need to update multiple parts of the page independently. A game board update should not redraw the chat history. A background animation should not affect the sidebar.

So I built a delimiter-based protocol. The model wraps every update in a structured envelope:

```
PpqUtcLGQdYN4oqc:BODY_START
<template for="/chat/append-message">
  <div class="message message-user" data-client-id="1">Lets play Tic Tac Toe</div>
  <div class="message message-agent message-full-width" id="msg-1">
    <!-- full game board HTML here -->
  </div>
  <?marker name="/chat/append-message">
</template>
PpqUtcLGQdYN4oqc:BODY_END
```

The `for` attribute on the template targets a named marker in the DOM. The client-side runtime walks the document tree looking for processing instructions with matching names and replaces them with the template content.

This is built on two browser polyfills: `html-setters-polyfill` and `template-for-polyfill`, which implement the [Dynamic Partial Update](https://developer.chrome.com/blog/declarative-partial-updates) spec that is landing in Chrome.

A single AI response can contain multiple messages separated by a split delimiter. So the model can send a chat confirmation to all users AND simultaneously update a specific game cell for only the player who just moved.

```
PpqUtcLGQdYN4oqc:SPLIT_MESSAGE
PpqUtcLGQdYN4oqc:SERVER_PROPS_START
{ clients: { type: 'include', ids: ['2'] } }
PpqUtcLGQdYN4oqc:SERVER_PROPS_END
```

The server strips SERVER_PROPS before forwarding to the browser. Clients never see routing instructions, only their content.

[IMAGE: Debug view showing raw LLM message history with protocol delimiters]

---

## Multi-User Sync

Every chat URL is shared. Open it in two browser tabs and both receive every AI response in real time over WebSockets.

Each client gets a unique `clientId` and `clientSecret` issued by the DO. User bubbles are color-coded by client. The LLM knows each client's ID and can address them individually:

```
[1]: Lets play a guessing game
[2]: I want to guess too
```

The model can respond with one message visible to both players and a second message containing the secret word visible only to client 1. All routed server-side before it hits WebSockets.

[IMAGE: Two browser windows open side by side on the same chat URL]

---

## The UI

The interface is a full dark-mode app shell built with pure CSS custom properties. No framework, no Tailwind, no component library. Just Inter, a deep navy palette, and a periwinkle indigo accent.

The sidebar and topbar are always opaque. The chat viewport sits behind them and is the only zone where backgrounds and themes can render. This prevents the AI from accidentally overriding the shell with a space photo.

[IMAGE: FlowChat default dark UI with welcome screen and suggestion cards]

The welcome screen has four suggestion cards that pre-fill and auto-submit the prompt. Clicking "Tic Tac Toe" sends the prompt and the AI starts building immediately.

Messages use a spring entrance animation. User bubbles are right-aligned with per-client color coding. Agent bubbles are left-aligned with a subtle border. There is a three-dot typing indicator while the model generates.

[IMAGE: Chat with multiple messages, typing indicator visible]

---

## The System Prompt Engineering

Getting the AI to consistently produce valid HTML in the protocol format took a lot of iteration. The system prompt is about 300 lines and covers:

Every CSS variable in the design system with its hex value, so the model uses `var(--accent)` correctly. Rules for borders, shadows, border-radius, and animation timing. The exact wrong-vs-correct template structure with visual examples showing where the `<?marker>` must go. The async CDN pattern for Chart.js and d3, because the model kept calling `new Chart()` before the library loaded. Canvas sizing rules. MutationObserver cleanup patterns for scripts. The multi-user SERVER_PROPS routing format with concrete examples.

The biggest bug I chased: the model kept putting the append-message marker inside the app container div instead of after it. Every subsequent message would inject into the game board instead of the chat list. The fix was a wrong/correct example in the system prompt with explicit comments:

```html
<!-- WRONG: marker inside app div -->
<div id="ttt-app-1">
  ...board...
  <?marker name="/chat/append-message">  <!-- injections go here forever -->
</div>

<!-- CORRECT: marker after ALL divs close -->
<div id="ttt-app-1">
  ...board...
</div>
<?marker name="/chat/append-message">  <!-- injections go to the chat list -->
```

[IMAGE: A working Tic Tac Toe game with multiple moves made]

---

## What You Can Build With It

Here is a sample of things I tested during development:

**Games**: Tic Tac Toe with AI opponent, Connect 4, Snake on canvas. The game state lives in the DO's SQLite, moves are submitted via HTML forms targeting a hidden iframe, and the AI updates only the cells that changed.

**Dashboards**: Live charts using Chart.js loaded from CDN. The model polls until `typeof Chart !== 'undefined'` before initializing, which is the correct async pattern for CDN scripts.

**Interface themes**: Barbie pink, Oppenheimer sepia, terminal green-on-black. The AI injects CSS overrides via style markers. The sidebar and topbar stay opaque regardless.

**Background animations**: Starfields, DVD bounce, particle systems, space images. These render in a contained layer behind the chat messages using the `/page/background` marker, which is an absolutely-positioned layer inside the chat viewport.

**Wikipedia mode**: The AI replaced the prompt box with links. Clicking any link submitted a form back to the AI which generated a new article replacing the chat content.

**Cross-language chat**: Two users typing in different languages, each seeing the conversation translated into their own language in real time.

[IMAGE: Snake game running on canvas inside a chat bubble]

[IMAGE: Wikipedia-style layout the AI generated from a prompt]

---

## Deploying It

The whole thing deploys to Cloudflare Workers free tier with one command:

```bash
npx wrangler deploy --env public
```

No Docker, no server setup, no managed database to provision. Cloudflare handles scaling, WebSocket hibernation, global distribution, and the SQLite storage inside each Durable Object.

The live version is at:

**https://flowchat-public.varshithvh.workers.dev**

The source is fully open:

**https://github.com/Varshithvhegde/flowchat**

---

## What I Learned

**Diffusion models stream differently.** Mercury-2 generates tokens in a way that feels less like watching a cursor type and more like content materializing. It pairs well with this use case because the protocol already batches updates.

**Durable Objects are genuinely good for this pattern.** Each chat is an isolated actor. There is no shared state, no race conditions between chats, and the SQLite storage is fast. The LLM queue inside the DO serializes concurrent prompts cleanly.

**System prompts are programs.** Writing the initial prompt felt like writing an API contract. Wrong examples are more useful than correct-only documentation because the model needs to know exactly what failure mode to avoid.

**CSS custom properties make AI-generated themes work.** Because everything uses `var(--accent)` and `var(--bg)`, the model can retheme the entire interface by overriding a handful of variables in a single style block. It does not need to know every selector.

**Isolation beats enforcement.** Trying to lock backgrounds with `!important` and MutationObservers turned into an infinite loop that froze the page. Structural containment, putting the background layer inside the chat viewport as a sibling of `.chat` with `z-index: 2` on the chat, was cleaner and simpler.

---

If you want to try it, open a new chat and type anything. The AI responds with live HTML. Ask it to build something, change the theme, or add a background. It will.

And if you want to run your own copy with your own API key, clone the repo and follow the README.

{% github Varshithvhegde/flowchat %}

---

*Built with Cloudflare Workers, Durable Objects, TypeScript, and Inception Labs Mercury-2.*
