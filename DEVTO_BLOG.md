---
title: I Built a Chat App Where the AI Responds With Live HTML (Games, Dashboards, Animations)
published: true
description: FlowChat is a multi-user AI chat where the model generates real HTML, CSS, and JS on every reply. Not markdown. Not a code block. A working Tic Tac Toe board you can click.
tags: webdev, cloudflare, ai, javascript
cover_image: [YOUR SCREENSHOT: Full app with space background + Barbie theme + game running in chat]
---

So I had this idea that kept nagging at me.

Every AI chat app works the same way. You type something, the model returns text or markdown, the UI renders it as a nice formatted paragraph. That is fine if you want an answer. It is genuinely boring if you want to actually *build* something.

What if the AI could respond with a working game board you could click? What if saying "make it Barbie themed" actually transformed the whole interface while you watched? What if "add a starfield in the background" dropped an animated canvas behind your chat in real time?

I spent a few weeks building exactly that. I call it **FlowChat**.

Here is the live version: **https://flowchat-public.varshithvh.workers.dev**

And yes, someone immediately asked it to play Tic Tac Toe and then asked it to switch to an Oppenheimer theme mid-game. I could not be prouder.

{% embed https://flowchat-public.varshithvh.workers.dev %}

---

## The Idea

Normal AI chat: model returns markdown, client renders it as text. Simple, predictable, boring.

FlowChat: model returns raw HTML with CSS and JavaScript, client injects it directly into the DOM using a streaming protocol built on the browser's native template system.

That one change makes the entire experience different. You are not reading about a game. You are playing one. You are not reading about a Barbie color palette. You are sitting inside one.

The AI does not just answer questions. It *rebuilds the UI from its responses*.

[IMAGE: Screenshot of Tic Tac Toe game running live inside a chat bubble]

---

## What You Can Actually Do With It

I want to give you a feel for what this means in practice before getting into the technical bits, because the demos are more interesting than any architecture diagram.

**Games**: Ask it to build Tic Tac Toe. You get a playable board, click-to-move, an AI opponent, win detection. Ask for Connect 4. Ask for Snake. The game renders in the chat as an agent bubble with a form inside it. Each move submits to the LLM which processes it and updates only the cells that changed.

**Themes**: Say "change to a Barbie theme". The model injects CSS overrides and the whole interface turns pink. Messages, borders, buttons, the prompt box. Say "Oppenheimer themed". You get dark sepia tones and heavy typography. The sidebar and topbar stay locked so the shell never breaks, but everything inside the chat transforms.

**Backgrounds**: Say "add a starfield". An animated canvas renders behind your messages. Say "DVD bounce animation". The logo bounces around the chat viewport. Say "use a space image". An image fills the background. All of this lives in a contained layer so it never covers the actual UI.

**Full interface takeover**: At one point I asked it to make the page look like Wikipedia. It replaced the prompt box with links. Clicking any link submitted a form back to the LLM which generated a new article replacing the chat content. I was reading about the Roman Empire in a chat app I built on a Sunday afternoon.

[IMAGE: Barbie themed interface with pink gradients]

[IMAGE: Space background visible behind chat messages]

---

## The Tech Stack

Everything runs on Cloudflare's edge infrastructure. No traditional server. No Node.js process to keep alive. No managed database to worry about.

**Cloudflare Workers** runs the TypeScript on every request. Cold starts are under 50ms globally. The whole worker is one file that handles routing, auth, rate limiting, WebSocket upgrades, and LLM streaming.

**Cloudflare Durable Objects** is the part that makes this work. Each chat room is a single Durable Object: a stateful actor with its own SQLite database, its own in-memory queue, and its own WebSocket connections. When you and a friend open the same chat URL, you both connect to the same DO. Sync is not something you have to build. It is just how the architecture works.

Each DO stores:
- The full LLM message history in SQLite
- Client session records
- A queue of pending prompts (max 5)
- Rate limit state per browser/IP
- A fork index for read-only snapshots

**Hibernatable WebSockets** keep connections alive without keeping the DO alive. Cloudflare auto-handles ping/pong. The DO wakes up when a message arrives and goes back to sleep between them.

**better-auth** handles optional authentication. If you do not configure it, the app is open to everyone. If you do, you get Google, GitHub, and email/password with role-based access (admin, dev, chat, view, blocked).

**Inception Labs Mercury-2** is the model powering responses. It is a diffusion-based language model rather than autoregressive, which means it generates differently to GPT or Claude. In practice it feels fast and it seems to genuinely understand the HTML output format I need from it.

[IMAGE: Wrangler terminal showing bindings after deploy]

---

## The Protocol

This was the most enjoyable part to design and the part I am most proud of.

The AI cannot just dump raw HTML into a response stream. A single response might need to update three different parts of the page independently. A Tic Tac Toe move should update one cell, not redraw the entire board. A background animation should not affect the sidebar. A private message to one player should not appear in the other player's chat.

So I built a delimiter-based streaming protocol. The model wraps every DOM update in a structured envelope:

```
PpqUtcLGQdYN4oqc:BODY_START
<template for="/chat/append-message">
  <div class="message message-user" data-client-id="1">Lets play Tic Tac Toe</div>
  <div class="message message-agent message-full-width" id="msg-1">
    <!-- entire game board HTML -->
  </div>
  <?marker name="/chat/append-message">
</template>
PpqUtcLGQdYN4oqc:BODY_END
```

The `for` attribute on the template targets a named marker in the DOM. The client runtime walks the document tree looking for processing instructions with matching names and replaces them with the template content. Surgically. Without touching anything else on the page.

A single AI response can contain multiple messages separated by a split delimiter:

```
PpqUtcLGQdYN4oqc:SPLIT_MESSAGE
```

So the model can send a public chat confirmation to all users AND simultaneously route a private message to only one player by including SERVER_PROPS routing instructions that the server strips before forwarding over WebSockets.

The whole thing is built on two browser polyfills that implement the [Dynamic Partial Update](https://developer.chrome.com/blog/declarative-partial-updates) spec that is landing in Chrome.

[IMAGE: Debug view showing raw LLM message history with protocol delimiters visible]

---

## Writing the System Prompt

Getting the AI to consistently produce valid HTML inside this protocol format took a lot of iteration. The final system prompt is about 300 lines and honestly reads more like an API contract than a prompt.

It covers the exact hex values of every CSS variable in the design system so the model writes `var(--accent)` correctly instead of guessing colors. Rules for border-radius, shadow values, animation timing. The async CDN loading pattern for Chart.js and d3, because the model kept calling `new Chart()` before the library loaded.

The biggest bug I chased was this one: the model kept placing the append-message marker *inside* the app container div instead of after it. Every subsequent chat message would inject into the game board. I fixed it with a wrong-vs-correct example in the prompt:

```html
<!-- WRONG: marker inside app div, next message injects here forever -->
<div id="ttt-app-1">
  ...board...
  <?marker name="/chat/append-message">
</div>

<!-- CORRECT: marker after ALL divs close -->
<div id="ttt-app-1">
  ...board...
</div>
<?marker name="/chat/append-message">
```

Wrong examples with explicit comments are more useful than correct-only documentation. The model needs to know what the failure mode looks like, not just the happy path.

I also learned that diffusion models like Mercury-2 need slightly different prompting than autoregressive models. The responses feel less like a typewriter and more like content materializing. It pairs naturally with this use case.

---

## Multi-User by Default

Every chat URL is shared. Open the same link in two browser tabs and both receive every AI response over WebSockets in real time. Each client gets a unique ID. User bubbles are color-coded per client.

The LLM knows each client's ID:

```
[1]: I want to guess a secret word
[2]: I want to give the hint
```

The model can respond with one message visible to both players and a second message containing the secret visible only to client 1. Routed server-side, stripped from WebSocket payloads before they reach the wrong browser.

I did not add any special multi-user logic. The Durable Object architecture just makes it work naturally. Every client connects to the same DO instance. The DO has the WebSocket connections. When the LLM responds, the DO broadcasts to all of them.

[IMAGE: Two browser windows on the same chat URL receiving the same message]

---

## The UI

Pure CSS. No framework, no Tailwind, no component library. Inter font loaded non-blocking, a deep navy palette (`#06091a` to `#101630`), periwinkle indigo accent (`#5b6ef5`).

The app shell is a sidebar plus a main area with topbar. The sidebar and topbar are always physically opaque. The chat viewport is the only zone where themes and backgrounds can render. This prevents the AI from accidentally covering the navigation with a space photo, which it absolutely would do otherwise. I know because it did, many times, before I fixed the containment.

```css
.chat-viewport {
  position: relative;
  isolation: isolate;
}

#fc-bg-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none !important;
}

.chat {
  position: relative;
  z-index: 2;
}
```

The background layer sits at z-index 0. Chat messages sit at z-index 2. The sidebar and topbar are separate elements outside the viewport entirely. Structural containment beats trying to enforce it with `!important` and MutationObservers, which I tried first and which caused an infinite loop that froze the whole page. Lesson learned.

Typing indicator, optimistic user bubbles, spring entrance animations on messages. The send button has a glow. It is small things but they add up.

[IMAGE: Default dark UI with welcome screen and suggestion cards]

---

## Some Honest Pain Points

**The model marker placement bug** took two days to properly fix because the issue was invisible until the second message arrived. The first message always looked correct.

**The background containment wars** took about a week of back-and-forth. I tried CSS `!important`, then a MutationObserver enforcer, then a JS-level background lock. All of them broke something else. The right answer was structural: move the background layer inside the chat viewport so it is physically impossible for it to escape.

**CDN script loading** trips up every AI-generated app. The model writes code that calls `Chart.js` APIs before the library loads. The fix is teaching it to poll:

```javascript
function init() {
  if (typeof Chart === 'undefined') { setTimeout(init, 50); return; }
  // safe to use Chart here
}
init();
```

That pattern is now baked into the system prompt and it works reliably.

**The form action URL bug** was embarrassing. The form action in `app.html` was `c/CHAT_ID/prompt` (relative) instead of `/c/CHAT_ID/prompt` (absolute). On a fresh load the path resolved correctly. After a redirect it did not. Every prompt submitted to `/c/c/CHAT_ID/prompt` and got a 404. I caught it from the server logs and added a global form submit interceptor that normalizes any relative action URL before submission, as a safety net for AI-generated forms too.

---

## Deploying

The whole thing runs on Cloudflare's free tier. One command:

```bash
npx wrangler deploy --env public
```

No Docker. No server to provision. No database UI to configure. Cloudflare handles scaling, WebSocket hibernation, global distribution, and the SQLite storage inside each Durable Object automatically.

Secrets like the API key are stored via Wrangler:

```bash
npx wrangler secret put INCEPTION_API_KEY --env public
```

They never touch the codebase or version control.

---

## Try It

Live: **https://flowchat-public.varshithvh.workers.dev**

Source: **https://github.com/Varshithvhegde/flowchat**

Open a new chat. Type anything. Ask it to build a game, change the theme, add a background, or make the page look like something completely different. It will.

{% github Varshithvhegde/flowchat %}

---

The thing I keep coming back to is how much of this was just moving one assumption. Instead of "the AI returns text and the UI renders it", it became "the AI returns HTML and the browser runs it". That one change opened up everything else.

If you have questions about the protocol, the Durable Objects architecture, or the system prompt engineering, ask in the comments. I spent a lot of time on all three and I am happy to go deeper on any of it.

And if you build something interesting with it, or fork it and take it somewhere I did not think of, I genuinely want to see it.

You can also find me on LinkedIn and Dev.to. I write about things I am actually building, not things I think I should be building. There is a difference.

[OPTIONAL CLOSING IMAGE: Your favorite screenshot from testing, whatever made you laugh or surprised you most]
