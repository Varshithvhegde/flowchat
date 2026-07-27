import { DurableObject } from "cloudflare:workers";
import appStyles from "./app.css";
import appHtml from "./app.html";
import pageStyles from "./page.css";
import { handleAuthRoute, isAuthRoute } from "./auth/routes";
import { isAuthEnabled } from "./auth/providers";
import { getAuthSession } from "./auth/server";
import {
  requireRolePermission,
  type RoleGateResult,
  type RolePermission,
} from "./auth/roles";
import {
  renderDebugPage,
  type DebugState,
  type LlmMessage,
  type LlmRole,
} from "./debug";
import type { AppEnv } from "./env";
import { getPrompt } from "./getPrompt";

type ChatRole = "user" | "assistant" | "form";
type UpdateType = "html" | "json";
type ClientMode = "include" | "exclude";

type ChatMessage = {
  id: number;
  role: ChatRole;
  clientId: string;
  content: string;
  createdAt: number;
};

type ChatSnapshot = {
  messages: ChatMessage[];
  llmMessages: LlmMessage[];
  llmUpdatedAt: string;
};

type Update = {
  clients: { mode: ClientMode; ids: string[] };
  type: UpdateType;
  path: string;
  payload: string;
};

type ReplayTurn = { prompt: string; updates: Update[] };

type ClientUpdate = { type: UpdateType; path: string; payload: string };

type ClientUpdateTurn = { prompt: string; updates: ClientUpdate[] };

type ReplayPageOptions = {
  agentDelay: number;
  agentDisplay: "block" | "flex" | "grid" | "";
  agentDuration: number;
  enabled: boolean;
  pause: number;
  promptLimit: number;
  turn: number;
};

type ClientSession = { clientId: string; clientSecret: string };

type LlmQueueItem = {
  id: string;
  clientId: string;
  prompt: string;
  createdAt: number;
  rateLimitPermits: RateLimitPermit[];
};

type LlmQueueState = {
  active?: LlmQueueItem;
  activeStartedAt?: number;
  items: LlmQueueItem[];
};

type SubmitResult =
  | { kind: "accepted" }
  | { kind: "empty" }
  | { kind: "queueFull"; message: string };

type RateLimitScope = "browser" | "ip";
type RateLimitAction = "newChat" | "prompt";

type RateLimitPermit = { objectName: string; permitId: string };

type RateLimitDecision =
  | { allowed: true; permitId?: string }
  | { allowed: false; retryAfter: number };

type RateLimitState = {
  active: Array<{ id: string; expiresAt: number }>;
  newChats: number[];
  prompts: number[];
};

type PromptAdmission =
  | { allowed: true; permits: RateLimitPermit[] }
  | { allowed: false; retryAfter: number };

type RateLimitContext = {
  browserObjectName?: string;
  ipObjectName?: string;
  setCookie?: string;
};

type WebSocketAttachment = {
  clientId: string;
  clientSecret: string;
  chatId: string;
};

declare global {
  interface Element {
    appendHTML?(html: string): void;
    appendHTMLUnsafe?(html: string): void;
  }
}

const htmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
};

const PROTOCOL_PREFIX = "PpqUtcLGQdYN4oqc";
const SPLIT_MESSAGE = `${PROTOCOL_PREFIX}:SPLIT_MESSAGE`;
const SERVER_PROPS_START = `${PROTOCOL_PREFIX}:SERVER_PROPS_START`;
const SERVER_PROPS_END = `${PROTOCOL_PREFIX}:SERVER_PROPS_END`;
const CLIENT_PROPS_START = `${PROTOCOL_PREFIX}:CLIENT_PROPS_START`;
const CLIENT_PROPS_END = `${PROTOCOL_PREFIX}:CLIENT_PROPS_END`;
const BODY_START = `${PROTOCOL_PREFIX}:BODY_START`;
const BODY_END = `${PROTOCOL_PREFIX}:BODY_END`;
const CLIENT_ID_TOKEN = `${PROTOCOL_PREFIX}:CLIENT_ID`;
const CLIENT_SECRET_TOKEN = `${PROTOCOL_PREFIX}:CLIENT_SECRET`;
const CHAT_ID_TOKEN = `${PROTOCOL_PREFIX}:CHAT_ID`;
const FORK_ID_TOKEN = `${PROTOCOL_PREFIX}:FORK_ID`;
const FORK_INDEX_OBJECT = "__fork_index";
const LLM_QUEUE_KEY = "llmQueue";
const LLM_QUEUE_LIMIT = 5;
const LLM_QUEUE_ACTIVE_STALE_MS = 5 * 60 * 1000;
const PROMPT_MAX_CHARACTERS_DEFAULT = 20000;
const RATE_LIMIT_COOKIE_NAME = "flowchat_browser";
const RATE_LIMIT_COOKIE_SECRET_KEY = "rateLimitCookieSecret";
const RATE_LIMIT_STATE_KEY = "rateLimitState";
const RATE_LIMIT_PERMIT_EXPIRY_MS = 5 * 60 * 1000;
const REPLAY_PROMPT_LIMIT_MAX = 1_000_000;
const IP_MAX_ACTIVE_LLM_REQUESTS = 20;
const IP_MAX_PROMPTS_PER_MINUTE = 60;
const IP_MAX_PROMPTS_PER_HOUR = 300;
const IP_MAX_NEW_CHATS_PER_HOUR = 100;
const BROWSER_MAX_ACTIVE_LLM_REQUESTS = 2;
const BROWSER_MAX_PROMPTS_PER_MINUTE = 10;
const BROWSER_MAX_PROMPTS_PER_HOUR = 60;
const BROWSER_MAX_NEW_CHATS_PER_HOUR = 15;

export class FlowChat extends DurableObject<AppEnv> {
  private llmDrainRunning = false;
  private queueMutation: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ensureSchema();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/socket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const chatId = url.searchParams.get("chatId");
      const clientId = url.searchParams.get("clientId");
      const clientSecret = url.searchParams.get("clientSecret");

      if (!chatId || !clientId || !clientSecret) {
        return new Response("Missing chatId or client session", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ chatId, clientId, clientSecret } satisfies WebSocketAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async nextClientId(): Promise<string> {
    const clientId = this.getNextClientId();
    this.setNextClientId(clientId + 1);
    return String(clientId);
  }

  async issueClientSession(
    requestedClientId = "",
    requestedClientSecret = "",
  ): Promise<ClientSession> {
    if (
      requestedClientId &&
      requestedClientSecret &&
      this.isValidClientSession(requestedClientId, requestedClientSecret)
    ) {
      this.touchClientSession(requestedClientId);
      return { clientId: requestedClientId, clientSecret: requestedClientSecret };
    }

    const clientId = await this.nextClientId();
    const clientSecret = newClientSecret();
    this.ctx.storage.sql.exec(
      "INSERT INTO clients (client_id, secret, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
      clientId, clientSecret, Date.now(), Date.now(),
    );
    return { clientId, clientSecret };
  }

  async getInitialPage(
    chatId: string,
    clientSession: ClientSession,
    replay: ReplayPageOptions = defaultReplayPageOptions(),
  ): Promise<string> {
    const forkId = await this.ensureForkId(chatId);
    this.ensureSystemMessage(clientSession.clientId, chatId);
    const turns = this.readReplayTurns(1000)
      .map((turn) => toClientUpdateTurn(turn, chatId, clientSession.clientId, clientSession.clientSecret, forkId))
      .filter((turn) => turn.updates.length > 0);

    return renderAppPage({
      chatId,
      clientId: clientSession.clientId,
      clientSecret: clientSession.clientSecret,
      forkId,
      history: turns,
      replay,
      title: `FlowChat · ${chatId}`,
    });
  }

  async getForkId(chatId: string): Promise<string> {
    return this.ensureForkId(chatId);
  }

  async getReadOnlyForkPage(
    _chatId: string,
    forkId: string,
    clientSession: ClientSession,
    canSubmit = true,
    replay: ReplayPageOptions = defaultReplayPageOptions(),
  ): Promise<string> {
    const turns = this.readReplayTurns(1000)
      .map((turn) => toClientUpdateTurn(turn, forkId, clientSession.clientId, clientSession.clientSecret, forkId))
      .filter((turn) => turn.updates.length > 0);

    return renderAppPage({
      chatId: forkId,
      clientId: clientSession.clientId,
      clientSecret: clientSession.clientSecret,
      connect: false,
      forkId,
      interceptSubmits: !canSubmit,
      history: turns,
      replay,
      title: `FlowChat fork · ${forkId}`,
    });
  }

  async getDebugState(chatId: string): Promise<DebugState> {
    return {
      messages: this.readLlmMessages(),
      objectId: chatId,
      updatedAt: this.getLlmUpdatedAt(),
    };
  }

  async clearHistory(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    this.setNextClientId(0);
    await this.broadcast({
      clients: { mode: "exclude", ids: [] },
      path: "/body",
      payload: `<template for="/chat/append-message">
	<?start name="/chat/append-message">
	<?marker name="/chat/append-message">
</template>`,
      type: "html",
    });
    await this.broadcastReload();
  }

  async validateClientSession(clientId: string, clientSecret: string): Promise<boolean> {
    if (!clientId || !clientSecret) return false;
    const valid = this.isValidClientSession(clientId, clientSecret);
    if (valid) this.touchClientSession(clientId);
    return valid;
  }

  async hardUndo(undoCount: number, submittingClientId: string): Promise<void> {
    const count = normalizeUndoCount(undoCount);

    for (let index = 0; index < count; index += 1) {
      this.deleteLatestVisibleTurn();
      this.deleteLatestLlmTurn();
    }

    if (count > 0) {
      await this.broadcast({
        clients: { mode: "exclude", ids: [submittingClientId] },
        path: "/page/reload",
        payload: "{}",
        type: "json",
      });
    }
  }

  async broadcastReload(): Promise<void> {
    await this.broadcast({
      clients: { mode: "exclude", ids: [] },
      path: "/page/reload",
      payload: "{}",
      type: "json",
    });
  }

  async lookupFork(forkId: string): Promise<string | undefined> {
    const rows = this.ctx.storage.sql
      .exec("SELECT chat_id FROM fork_index WHERE fork_id = ?", forkId)
      .toArray() as Array<{ chat_id: string }>;
    return rows[0]?.chat_id;
  }

  async lookupChatFork(chatId: string): Promise<string | undefined> {
    const rows = this.ctx.storage.sql
      .exec("SELECT fork_id FROM fork_index WHERE chat_id = ?", chatId)
      .toArray() as Array<{ fork_id: string }>;
    return rows[0]?.fork_id;
  }

  async registerFork(chatId: string, forkId: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fork_index (fork_id, chat_id, created_at) VALUES (?, ?, ?)",
      forkId, chatId, Date.now(),
    );
    return result.rowsWritten > 0;
  }

  async snapshotForFork(): Promise<ChatSnapshot> {
    return {
      llmMessages: this.readLlmMessages(),
      llmUpdatedAt: this.getLlmUpdatedAt(),
      messages: this.readMessages(),
    };
  }

  async cloneFromSnapshot(chatId: string, clientId: string, snapshot: ChatSnapshot): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    this.setNextClientId(maxClientId(snapshot.messages) + 1);
    const forkId = await this.ensureForkId(chatId);
    this.addLlmMessage("system", getPrompt(clientId, chatId, forkId));

    for (const message of snapshot.llmMessages) {
      if (message.role === "system") continue;
      this.addLlmMessage(message.role, message.content);
    }

    for (const message of snapshot.messages) {
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (role, client_id, content, created_at) VALUES (?, ?, ?, ?)",
        message.role, message.clientId, message.content, message.createdAt,
      );
    }

    this.setMetadata("llmUpdatedAt", snapshot.llmUpdatedAt);
  }

  async submitPrompt(
    clientId: string,
    prompt: string,
    chatId = "chat",
    rateLimitPermits: RateLimitPermit[] = [],
  ): Promise<SubmitResult> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return { kind: "empty" };

    const queued = await this.enqueueLlmRequest(clientId, normalizedPrompt, rateLimitPermits);

    if (!queued) return { kind: "queueFull", message: normalizedPrompt };

    await this.addMessage("user", clientId, normalizedPrompt);
    this.ctx.waitUntil(this.drainLlmQueue(chatId));
    return { kind: "accepted" };
  }

  async submitForm(
    clientId: string,
    fields: Record<string, string>,
    chatId = "chat",
    rateLimitPermits: RateLimitPermit[] = [],
  ): Promise<SubmitResult> {
    const description = fields.description?.trim() || "form submission";
    const fieldText = Object.entries(fields)
      .filter(([key]) => key !== "clientId" && key !== "clientSecret")
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    const prompt = `${clientId}: ${description}\n${fieldText}`.trim();
    const modelPrompt = formatFormPrompt(fields);

    const queued = await this.enqueueLlmRequest(clientId, modelPrompt, rateLimitPermits);

    if (!queued) return { kind: "queueFull", message: prompt };

    await this.addMessage("form", clientId, prompt);
    this.ctx.waitUntil(this.drainLlmQueue(chatId));
    return { kind: "accepted" };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") { ws.send("pong"); return; }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  async acquireRateLimit(scope: RateLimitScope, action: RateLimitAction): Promise<RateLimitDecision> {
    return this.withQueueMutation(async () => {
      const now = Date.now();
      const hourAgo = now - 60 * 60 * 1000;
      const minuteAgo = now - 60 * 1000;
      const limits = rateLimitsForScope(scope);
      const stored = (await this.ctx.storage.get<RateLimitState>(RATE_LIMIT_STATE_KEY)) ?? emptyRateLimitState();
      const state: RateLimitState = {
        active: stored.active.filter((permit) => permit.expiresAt > now),
        newChats: stored.newChats.filter((timestamp) => timestamp > hourAgo),
        prompts: stored.prompts.filter((timestamp) => timestamp > hourAgo),
      };

      if (action === "newChat") {
        if (state.newChats.length >= limits.newChatsPerHour) {
          await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
          return { allowed: false, retryAfter: retryAfterSeconds(state.newChats[0], hourAgo) };
        }
        state.newChats.push(now);
        await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
        return { allowed: true };
      }

      const promptsLastMinute = state.prompts.filter((timestamp) => timestamp > minuteAgo);

      if (state.active.length >= limits.active) {
        await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
        return { allowed: false, retryAfter: retryAfterSeconds(Math.min(...state.active.map((p) => p.expiresAt)), now) };
      }

      if (promptsLastMinute.length >= limits.promptsPerMinute) {
        await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
        return { allowed: false, retryAfter: retryAfterSeconds(promptsLastMinute[0], minuteAgo) };
      }

      if (state.prompts.length >= limits.promptsPerHour) {
        await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
        return { allowed: false, retryAfter: retryAfterSeconds(state.prompts[0], hourAgo) };
      }

      const permitId = crypto.randomUUID();
      state.active.push({ id: permitId, expiresAt: now + RATE_LIMIT_PERMIT_EXPIRY_MS });
      state.prompts.push(now);
      await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
      return { allowed: true, permitId };
    });
  }

  async releaseRateLimitPermit(permitId: string): Promise<void> {
    await this.withQueueMutation(async () => {
      const state = await this.ctx.storage.get<RateLimitState>(RATE_LIMIT_STATE_KEY);
      if (!state) return;
      state.active = state.active.filter((permit) => permit.id !== permitId);
      await this.ctx.storage.put(RATE_LIMIT_STATE_KEY, state);
    });
  }

  async resolveBrowserRateLimitIdentity(
    cookieValue: string,
    issueCookie: boolean,
  ): Promise<{ browserId?: string; signedCookie?: string }> {
    let secret = await this.ctx.storage.get<string>(RATE_LIMIT_COOKIE_SECRET_KEY);

    if (!secret) {
      secret = crypto.randomUUID();
      await this.ctx.storage.put(RATE_LIMIT_COOKIE_SECRET_KEY, secret);
    }

    const browserId = cookieValue
      ? await verifyBrowserRateLimitCookie(cookieValue, secret)
      : undefined;

    if (browserId || !issueCookie) return { browserId };

    const issuedBrowserId = crypto.randomUUID();
    return {
      browserId: issuedBrowserId,
      signedCookie: await signBrowserRateLimitCookie(issuedBrowserId, secret),
    };
  }

  private async enqueueLlmRequest(
    clientId: string,
    prompt: string,
    rateLimitPermits: RateLimitPermit[],
  ): Promise<boolean> {
    return this.withQueueMutation(async () => {
      const queue = await this.readLlmQueue();
      const normalized = this.recoverStaleLlmQueueActive(queue);
      const queueSize = normalized.items.length + (normalized.active ? 1 : 0);

      if (queueSize >= LLM_QUEUE_LIMIT) {
        if (normalized !== queue) await this.writeLlmQueue(normalized);
        return false;
      }

      normalized.items.push({ id: crypto.randomUUID(), clientId, prompt, createdAt: Date.now(), rateLimitPermits });
      await this.writeLlmQueue(normalized);
      return true;
    });
  }

  private async drainLlmQueue(chatId: string): Promise<void> {
    if (this.llmDrainRunning) return;
    this.llmDrainRunning = true;

    try {
      while (true) {
        const next = await this.claimNextLlmRequest();
        if (!next) return;

        try {
          await this.runModel(next.clientId, chatId, next.prompt);
        } catch (error) {
          console.error("LLM queue item failed", {
            chatId,
            error: error instanceof Error ? error.message : String(error),
            itemId: next.id,
          });
        } finally {
          await this.finishLlmRequest(next.id);
          await this.releaseRateLimitPermits(next.rateLimitPermits);
        }
      }
    } finally {
      this.llmDrainRunning = false;
    }
  }

  private async claimNextLlmRequest(): Promise<LlmQueueItem | undefined> {
    return this.withQueueMutation(async () => {
      const queue = this.recoverStaleLlmQueueActive(await this.readLlmQueue());
      if (queue.active) { await this.writeLlmQueue(queue); return undefined; }

      const next = queue.items.shift();
      if (!next) { await this.writeLlmQueue(queue); return undefined; }

      queue.active = next;
      queue.activeStartedAt = Date.now();
      await this.writeLlmQueue(queue);
      return next;
    });
  }

  private async finishLlmRequest(itemId: string): Promise<void> {
    await this.withQueueMutation(async () => {
      const queue = await this.readLlmQueue();
      if (queue.active?.id === itemId) {
        queue.active = undefined;
        queue.activeStartedAt = undefined;
      }
      await this.writeLlmQueue(queue);
    });
  }

  private recoverStaleLlmQueueActive(queue: LlmQueueState): LlmQueueState {
    if (queue.active && queue.activeStartedAt && Date.now() - queue.activeStartedAt > LLM_QUEUE_ACTIVE_STALE_MS) {
      return { items: queue.items };
    }
    return queue;
  }

  private async readLlmQueue(): Promise<LlmQueueState> {
    const queue = await this.ctx.storage.get<LlmQueueState>(LLM_QUEUE_KEY);
    if (!queue || !Array.isArray(queue.items)) return { items: [] };
    return {
      active: queue.active ? { ...queue.active, rateLimitPermits: queue.active.rateLimitPermits ?? [] } : undefined,
      activeStartedAt: queue.activeStartedAt,
      items: queue.items.map((item) => ({ ...item, rateLimitPermits: item.rateLimitPermits ?? [] })),
    };
  }

  private async writeLlmQueue(queue: LlmQueueState): Promise<void> {
    await this.ctx.storage.put(LLM_QUEUE_KEY, queue);
  }

  private async releaseRateLimitPermits(permits: RateLimitPermit[]): Promise<void> {
    await Promise.all(
      permits.map((permit) => this.env.FLOW_CHAT.getByName(permit.objectName).releaseRateLimitPermit(permit.permitId)),
    );
  }

  private async withQueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queueMutation;
    let release = () => {};
    this.queueMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        client_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fork_index (
        fork_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS fork_index_fork_id_idx ON fork_index (fork_id);
      CREATE UNIQUE INDEX IF NOT EXISTS fork_index_chat_id_idx ON fork_index (chat_id);
    `);
  }

  private async runModel(clientId: string, chatId: string, prompt: string): Promise<void> {
    await this.ensureForkId(chatId);
    this.ensureSystemMessage(clientId, chatId);
    this.addLlmMessage(
      "user",
      prompt.startsWith("[form]:") ? prompt : formatClientPrompt(clientId, prompt),
    );
    const llmMessages = this.readLlmMessages();
    const parser = new UpdateStreamParser();
    let response = "";

    for await (const chunk of streamModelResponse(this.env, llmMessages, clientId)) {
      const normalizedChunk = normalizeModelOutput(sanitizeModelOutput(chunk), clientId);
      if (!normalizedChunk) continue;
      response += normalizedChunk;
      for (const update of parser.push(normalizedChunk)) {
        await this.broadcast(update);
      }
    }

    for (const update of parser.finish()) {
      await this.broadcast(update);
    }

    if (response) {
      await this.addMessage("assistant", clientId, response);
      this.addLlmMessage("assistant", response);
    }
  }

  private async broadcast(update: Update): Promise<void> {
    const staleSockets: WebSocket[] = [];
    const forkId = this.readForkId();

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as WebSocketAttachment | undefined;
      if (!attachment || !shouldSendToClient(update, attachment.clientId)) continue;

      try {
        socket.send(JSON.stringify(toClientUpdate(update, attachment.chatId, attachment.clientId, attachment.clientSecret, forkId)));
      } catch {
        staleSockets.push(socket);
      }
    }

    for (const socket of staleSockets) socket.close(1011, "Stale socket");
  }

  private deleteLatestVisibleTurn(): void {
    const assistant = this.ctx.storage.sql
      .exec("SELECT id FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1")
      .toArray() as Array<{ id: number }>;
    const assistantId = assistant[0]?.id;
    if (!assistantId) return;

    const prompt = this.ctx.storage.sql
      .exec("SELECT id FROM messages WHERE id < ? AND role IN ('user', 'form') ORDER BY id DESC LIMIT 1", assistantId)
      .toArray() as Array<{ id: number }>;

    this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", assistantId);
    if (prompt[0]?.id) this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", prompt[0].id);
  }

  private deleteLatestLlmTurn(): void {
    const assistant = this.ctx.storage.sql
      .exec("SELECT id FROM llm_messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1")
      .toArray() as Array<{ id: number }>;
    const assistantId = assistant[0]?.id;
    if (!assistantId) return;

    const prompt = this.ctx.storage.sql
      .exec("SELECT id FROM llm_messages WHERE id < ? AND role = 'user' ORDER BY id DESC LIMIT 1", assistantId)
      .toArray() as Array<{ id: number }>;

    this.ctx.storage.sql.exec("DELETE FROM llm_messages WHERE id = ?", assistantId);
    if (prompt[0]?.id) this.ctx.storage.sql.exec("DELETE FROM llm_messages WHERE id = ?", prompt[0].id);
  }

  private async addMessage(role: ChatRole, clientId: string, content: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, client_id, content, created_at) VALUES (?, ?, ?, ?)",
      role, clientId, content, Date.now(),
    );
  }

  private ensureSystemMessage(clientId: string, chatId: string): void {
    const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM llm_messages").one() as { count: number };
    if (row.count > 0) return;
    this.addLlmMessage("system", getPrompt(clientId, chatId, this.readForkId()));
  }

  private addLlmMessage(role: LlmRole, content: string): void {
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO llm_messages (role, content, created_at) VALUES (?, ?, ?)",
      role, content, createdAt,
    );
    this.setMetadata("llmUpdatedAt", new Date(createdAt).toISOString());
  }

  private readLlmMessages(): LlmMessage[] {
    return this.ctx.storage.sql
      .exec("SELECT role, content FROM llm_messages ORDER BY id ASC")
      .toArray() as unknown as LlmMessage[];
  }

  private readMessages(): ChatMessage[] {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, role, client_id, content, created_at FROM messages ORDER BY id ASC")
      .toArray() as Array<{ id: number; role: ChatRole; client_id: string; content: string; created_at: number }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      clientId: row.client_id,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  private readReplayTurns(limit = 100): ReplayTurn[] {
    const messages = this.ctx.storage.sql
      .exec("SELECT content FROM messages WHERE role = 'assistant' ORDER BY id ASC LIMIT ?", limit)
      .toArray() as Array<{ content: string }>;
    const llmTurns = this.readLlmReplayPrompts(limit);

    return messages.map((message, index) => ({
      prompt: llmTurns[index] ?? "",
      updates: parseAllUpdates(message.content),
    }));
  }

  private readLlmReplayPrompts(limit = 100): string[] {
    const messages = this.ctx.storage.sql
      .exec("SELECT role, content FROM llm_messages WHERE role IN ('user', 'assistant') ORDER BY id ASC")
      .toArray() as Array<{ role: LlmRole; content: string }>;
    const prompts: string[] = [];
    let latestUserPrompt = "";

    for (const message of messages) {
      if (message.role === "user") {
        latestUserPrompt = promptTextFromLlmUserMessage(message.content);
        continue;
      }

      if (message.role === "assistant") {
        prompts.push(latestUserPrompt);
        latestUserPrompt = "";
        if (prompts.length >= limit) break;
      }
    }

    return prompts;
  }

  private getNextClientId(): number {
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM metadata WHERE key = 'nextClientId'")
      .toArray() as Array<{ value: string }>;
    const parsed = Number.parseInt(rows[0]?.value ?? "0", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private setNextClientId(value: number): void {
    this.setMetadata("nextClientId", String(value));
  }

  private isValidClientSession(clientId: string, clientSecret: string): boolean {
    const rows = this.ctx.storage.sql
      .exec("SELECT secret FROM clients WHERE client_id = ?", clientId)
      .toArray() as Array<{ secret: string }>;
    return rows[0]?.secret === clientSecret;
  }

  private touchClientSession(clientId: string): void {
    this.ctx.storage.sql.exec("UPDATE clients SET last_seen_at = ? WHERE client_id = ?", Date.now(), clientId);
  }

  private readForkId(): string {
    return this.getMetadata("forkId") ?? "";
  }

  private async ensureForkId(chatId: string): Promise<string> {
    const existing = this.readForkId();
    if (existing) return existing;

    const index = this.env.FLOW_CHAT.getByName(FORK_INDEX_OBJECT);
    const indexed = await index.lookupChatFork(chatId);

    if (indexed) {
      this.setMetadata("forkId", indexed);
      return indexed;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const forkId = newForkId();
      if (await index.registerFork(chatId, forkId)) {
        this.setMetadata("forkId", forkId);
        return forkId;
      }
    }

    throw new Error("Unable to allocate fork id");
  }

  private getLlmUpdatedAt(): string {
    return this.getMetadata("llmUpdatedAt") ?? "1970-01-01T00:00:00.000Z";
  }

  private getMetadata(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM metadata WHERE key = ?", key)
      .toArray() as Array<{ value: string }>;
    return rows[0]?.value;
  }

  private setMetadata(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }
}

// ─────────────────────────── Worker fetch handler ────────────────────────────

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (isAuthRoute(url.pathname)) {
      return handleAuthRoute(request, env);
    }

    const route = parseRoute(url.pathname);
    const undoCount = parseUndoCount(url.searchParams.get("undo"));
    const hasUndoParam = url.searchParams.has("undo");
    const replay = parseReplayPageOptions(url.searchParams);

    if (
      request.method === "GET" &&
      route.kind !== "home" &&
      route.kind !== "unknown" &&
      route.legacy &&
      route.kind !== "socket"
    ) {
      return Response.redirect(canonicalChatUrl(url, route).toString(), 308);
    }

    if (request.method === "GET" && route.kind === "home") {
      const gate = await authorize(request, env, "chat");
      if (!gate.ok) return gate.response;

      const rateLimitContext = await resolveRateLimitContext(request, env, true);
      const admission = await acquireNewChatAdmission(env, rateLimitContext);

      if (!admission.allowed) {
        return withRateLimitCookie(rateLimitResponse(admission.retryAfter), rateLimitContext.setCookie);
      }

      return withRateLimitCookie(
        Response.redirect(new URL(chatPath(newChatId()), url.origin).toString(), 302),
        rateLimitContext.setCookie,
      );
    }

    if (request.method === "GET" && route.kind === "chat") {
      const forkSourceChatId = await lookupForkSourceChatId(env, route.chatId);

      if (forkSourceChatId) {
        const gate = await authorize(request, env, hasUndoParam ? "chat" : "viewFork");
        if (!gate.ok) return gate.response;

        if (hasUndoParam) {
          if (undoCount > 0) await env.FLOW_CHAT.getByName(forkSourceChatId).hardUndo(undoCount, "");
          return Response.redirect(new URL(chatPath(route.chatId), url.origin).toString(), 303);
        }

        const clientSession = newForkClientSession();
        const stub = env.FLOW_CHAT.getByName(forkSourceChatId);
        const rateLimitContext = await resolveRateLimitContext(request, env, true);
        return withRateLimitCookie(
          new Response(
            await stub.getReadOnlyForkPage(forkSourceChatId, route.chatId, clientSession, canBurnTokens(gate.role), replay),
            { headers: htmlHeaders },
          ),
          rateLimitContext.setCookie,
        );
      }

      const gate = await authorize(request, env, "chat");
      if (!gate.ok) return gate.response;

      const stub = env.FLOW_CHAT.getByName(route.chatId);

      if (hasUndoParam) {
        if (undoCount > 0) await stub.hardUndo(undoCount, "");
        return Response.redirect(new URL(chatPath(route.chatId), url.origin).toString(), 303);
      }

      const clientSession = await stub.issueClientSession(
        url.searchParams.get("clientId") || "",
        url.searchParams.get("clientSecret") || "",
      );
      const rateLimitContext = await resolveRateLimitContext(request, env, true);
      return withRateLimitCookie(
        new Response(await stub.getInitialPage(route.chatId, clientSession, replay), { headers: htmlHeaders }),
        rateLimitContext.setCookie,
      );
    }

    if (request.method === "GET" && route.kind === "fork") {
      const gate = await authorize(request, env, "chat");
      if (!gate.ok) return gate.response;

      const forkId = await env.FLOW_CHAT.getByName(route.chatId).getForkId(route.chatId);
      return Response.redirect(new URL(chatPath(forkId), url.origin).toString(), 302);
    }

    if (request.method === "GET" && route.kind === "socket") {
      const gate = await authorize(request, env, "websocket");
      if (!gate.ok) return gate.response;

      const clientId = url.searchParams.get("clientId");
      const clientSecret = url.searchParams.get("clientSecret");

      if (!clientId || !clientSecret) return new Response("Missing client session", { status: 400 });

      if (!(await env.FLOW_CHAT.getByName(route.chatId).validateClientSession(clientId, clientSecret))) {
        return new Response("Invalid client session", { status: 403 });
      }

      const socketUrl = new URL("https://flowchat.internal/socket");
      socketUrl.searchParams.set("chatId", route.chatId);
      socketUrl.searchParams.set("clientId", clientId);
      socketUrl.searchParams.set("clientSecret", clientSecret);

      return env.FLOW_CHAT.getByName(route.chatId).fetch(new Request(socketUrl.toString(), {
        headers: request.headers,
        signal: request.signal,
      }));
    }

    if (request.method === "GET" && route.kind === "debug") {
      const gate = await authorize(request, env, "debug");
      if (!gate.ok) return gate.response;

      const debugState = await env.FLOW_CHAT.getByName(route.chatId).getDebugState(route.chatId);
      return renderDebugPage(url, debugState);
    }

    if (request.method === "POST" && route.kind === "prompt") {
      const form = await request.formData();
      const clientId = getFormString(form, "clientId");
      const clientSecret = getFormString(form, "clientSecret");
      const prompt = getFormString(form, "prompt");

      if (!clientId || !clientSecret || !prompt) return new Response(null, { status: 400 });

      const gate = await authorize(request, env, "chat");
      if (!gate.ok) return gate.response;

      if (characterCount(prompt) > promptMaxCharacters(env)) {
        return renderClientOnlySystemMessage("Prompt too long.", 413);
      }

      const forkSourceChatId = await lookupForkSourceChatId(env, route.chatId);
      const stub = forkSourceChatId ? undefined : env.FLOW_CHAT.getByName(route.chatId);

      if (stub && !(await stub.validateClientSession(clientId, clientSecret))) {
        return new Response("Invalid client session", { status: 403 });
      }

      const rateLimitContext = await resolveRateLimitContext(request, env, false);
      const promptAdmission = await acquirePromptAdmission(env, rateLimitContext);

      if (!promptAdmission.allowed) return renderRateLimitSystemMessage(promptAdmission.retryAfter);

      if (forkSourceChatId) {
        const newChatAdmission = await acquireNewChatAdmission(env, rateLimitContext);

        if (!newChatAdmission.allowed) {
          await releaseRateLimitPermits(env, promptAdmission.permits);
          return renderRateLimitSystemMessage(newChatAdmission.retryAfter);
        }

        const newId = await createForkedChat(env, { clientId, sourceChatId: forkSourceChatId });
        const newStub = env.FLOW_CHAT.getByName(newId);
        const submitResult = await newStub.submitPrompt(clientId, prompt, newId, promptAdmission.permits);

        if (submitResult.kind === "queueFull") {
          await releaseRateLimitPermits(env, promptAdmission.permits);
          return renderClientOnlyQueueFullMessage(submitResult.message);
        }

        return renderParentRedirect(new URL(chatPath(newId), url.origin));
      }

      const submitResult = await stub!.submitPrompt(clientId, prompt, route.chatId, promptAdmission.permits);
      if (submitResult.kind === "queueFull") await releaseRateLimitPermits(env, promptAdmission.permits);
      return renderSubmitResult(submitResult);
    }

    if (request.method === "POST" && route.kind === "form") {
      const form = await request.formData();
      const fields = formDataToRecord(form);
      const clientId = fields.clientId || "unknown";
      const clientSecret = fields.clientSecret || "";

      const gate = await authorize(request, env, "chat");
      if (!gate.ok) return gate.response;

      const forkSourceChatId = await lookupForkSourceChatId(env, route.chatId);
      const stub = forkSourceChatId ? undefined : env.FLOW_CHAT.getByName(route.chatId);

      if (stub && !(await stub.validateClientSession(clientId, clientSecret))) {
        return new Response("Invalid client session", { status: 403 });
      }

      const rateLimitContext = await resolveRateLimitContext(request, env, false);
      const promptAdmission = await acquirePromptAdmission(env, rateLimitContext);

      if (!promptAdmission.allowed) return renderRateLimitSystemMessage(promptAdmission.retryAfter);

      if (forkSourceChatId) {
        const newChatAdmission = await acquireNewChatAdmission(env, rateLimitContext);

        if (!newChatAdmission.allowed) {
          await releaseRateLimitPermits(env, promptAdmission.permits);
          return renderRateLimitSystemMessage(newChatAdmission.retryAfter);
        }

        const newId = await createForkedChat(env, { clientId, sourceChatId: forkSourceChatId });
        const newStub = env.FLOW_CHAT.getByName(newId);
        const submitResult = await newStub.submitForm(clientId, fields, newId, promptAdmission.permits);

        if (submitResult.kind === "queueFull") {
          await releaseRateLimitPermits(env, promptAdmission.permits);
          return renderClientOnlyQueueFullMessage(submitResult.message);
        }

        return renderParentRedirect(new URL(chatPath(newId), url.origin));
      }

      const submitResult = await stub!.submitForm(clientId, fields, route.chatId, promptAdmission.permits);
      if (submitResult.kind === "queueFull") await releaseRateLimitPermits(env, promptAdmission.permits);
      return renderSubmitResult(submitResult);
    }

    if (request.method === "POST" && route.kind === "debugClear") {
      const gate = await authorize(request, env, "debug");
      if (!gate.ok) return gate.response;

      await env.FLOW_CHAT.getByName(route.chatId).clearHistory();
      return Response.redirect(new URL(chatPath(route.chatId, "debug"), url.origin).toString(), 303);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<AppEnv>;

// ──────────────────────────── Auth helpers ────────────────────────────────────

async function authorize(request: Request, env: AppEnv, permission: RolePermission): Promise<RoleGateResult> {
  if (isAuthEnabled(env) && !env.BETTER_AUTH_SECRET) {
    return { ok: false, response: new Response("Authentication is not configured", { status: 503 }) };
  }

  const session = isAuthEnabled(env) ? await getAuthSession(request, env) : null;
  return requireRolePermission(request, env, session, permission);
}

// ────────────────────────── Rate limit helpers ────────────────────────────────

async function resolveRateLimitContext(request: Request, env: AppEnv, issueBrowserCookie: boolean): Promise<RateLimitContext> {
  const context: RateLimitContext = {};
  const ipHash = await hashRateLimitKey(request.headers.get("CF-Connecting-IP") || "unknown");
  const ipObjectName = `__rate_ip_${ipHash}`;

  if (envFlagEnabled(env.IP_RATE_LIMIT)) context.ipObjectName = ipObjectName;

  if (!envFlagEnabled(env.BROWSER_RATE_LIMIT)) return context;

  const cookieValue = readCookie(request.headers.get("Cookie"), RATE_LIMIT_COOKIE_NAME) || "";
  const identity = await env.FLOW_CHAT.getByName(ipObjectName).resolveBrowserRateLimitIdentity(cookieValue, issueBrowserCookie);

  if (identity.signedCookie) {
    context.setCookie = serializeBrowserRateLimitCookie(identity.signedCookie, new URL(request.url).protocol === "https:");
  }

  context.browserObjectName = `__rate_browser_${identity.browserId || `unidentified_${ipHash}`}`;
  return context;
}

async function acquirePromptAdmission(env: AppEnv, context: RateLimitContext): Promise<PromptAdmission> {
  const permits: RateLimitPermit[] = [];

  for (const [scope, objectName] of [["ip", context.ipObjectName], ["browser", context.browserObjectName]] as const) {
    if (!objectName) continue;
    const decision = await env.FLOW_CHAT.getByName(objectName).acquireRateLimit(scope, "prompt");
    if (!decision.allowed) { await releaseRateLimitPermits(env, permits); return decision; }
    if (decision.permitId) permits.push({ objectName, permitId: decision.permitId });
  }

  return { allowed: true, permits };
}

async function acquireNewChatAdmission(env: AppEnv, context: RateLimitContext): Promise<RateLimitDecision> {
  for (const [scope, objectName] of [["ip", context.ipObjectName], ["browser", context.browserObjectName]] as const) {
    if (!objectName) continue;
    const decision = await env.FLOW_CHAT.getByName(objectName).acquireRateLimit(scope, "newChat");
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

async function releaseRateLimitPermits(env: AppEnv, permits: RateLimitPermit[]): Promise<void> {
  await Promise.all(permits.map((permit) => env.FLOW_CHAT.getByName(permit.objectName).releaseRateLimitPermit(permit.permitId)));
}

// ──────────────────────────── Fork helpers ────────────────────────────────────

async function lookupForkSourceChatId(env: AppEnv, forkId: string): Promise<string | undefined> {
  if (!forkId.startsWith("fork-")) return undefined;
  return env.FLOW_CHAT.getByName(FORK_INDEX_OBJECT).lookupFork(forkId);
}

async function createForkedChat(env: AppEnv, options: { clientId: string; sourceChatId: string }): Promise<string> {
  const newId = newChatIdFromFork();
  const source = env.FLOW_CHAT.getByName(options.sourceChatId);
  const snapshot = await source.snapshotForFork();
  await env.FLOW_CHAT.getByName(newId).cloneFromSnapshot(newId, options.clientId, snapshot);
  return newId;
}

// ──────────────────────────── Response helpers ───────────────────────────────

function renderParentRedirect(url: URL): Response {
  return new Response(
    `<!DOCTYPE html><script>window.parent.location.href = ${jsonForInlineScript(url.toString())};</script>`,
    { headers: htmlHeaders },
  );
}

function renderSubmitResult(result: SubmitResult): Response {
  if (result.kind === "queueFull") return renderClientOnlyQueueFullMessage(result.message);
  return new Response(null, { status: 204 });
}

function renderClientOnlyQueueFullMessage(message: string): Response {
  return renderClientOnlySystemMessage(
    `Too many requests at once — try again after the next response.<br><br>${escapeHtmlWithBreaks(message)}`,
    429,
    true,
  );
}

function renderClientOnlySystemMessage(
  message: string,
  status: number,
  messageIsHtml = false,
  extraHeaders?: HeadersInit,
): Response {
  const payload = `<template for="/chat/append-message">
	<div class="message message-system">${messageIsHtml ? message : escapeHtml(message)}</div>
	<?marker name="/chat/append-message">
</template>`;

  return new Response(
    `<!DOCTYPE html><script>
(() => {
	const update = ${jsonForInlineScript({ path: "/body", payload, type: "html" })};
	window.parent?.partialupdates?.dispatch(update);
})();
</script>`,
    { headers: { ...htmlHeaders, ...extraHeaders }, status },
  );
}

function renderRateLimitSystemMessage(retryAfter: number): Response {
  return renderClientOnlySystemMessage("Too many requests. Please try again shortly.", 429, false, {
    "Retry-After": String(retryAfter),
  });
}

function rateLimitResponse(retryAfter: number): Response {
  return new Response("Too many requests. Please try again shortly.", {
    headers: { "Retry-After": String(retryAfter) },
    status: 429,
  });
}

function withRateLimitCookie(response: Response, cookie: string | undefined): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

// ──────────────────────────── Page renderer ──────────────────────────────────

function canBurnTokens(role: "admin" | "dev" | "chat" | "view" | "blocked" | "anonymous" | "disabled"): boolean {
  return role === "admin" || role === "dev" || role === "chat" || role === "disabled";
}

function renderAppPage(options: {
  chatId: string;
  clientId: string;
  clientSecret: string;
  connect?: boolean;
  forkId: string;
  hidePrompt?: boolean;
  interceptSubmits?: boolean;
  history: ClientUpdateTurn[];
  replay?: ReplayPageOptions;
  title: string;
}): string {
  const body = injectPageIds(appHtml, options.chatId, options.clientId, options.clientSecret, options.forkId);
  const replay = options.replay ?? defaultReplayPageOptions();
  const isFork = options.chatId.startsWith("fork-");

  const chatLabel = options.chatId.startsWith("fork-")
    ? `⤷ ${options.chatId}`
    : options.chatId;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..800;1,14..32,300..800&display=swap" rel="stylesheet" media="print" onload="this.media='all'" />
    <noscript><link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..800;1,14..32,300..800&display=swap" rel="stylesheet" /></noscript>
    <script>${renderClientSessionRedirect(options.chatId)}</script>
    <script src="https://unpkg.com/html-setters-polyfill" async></script>
    <script src="https://unpkg.com/template-for-polyfill" async></script>
    <style>${pageStyles}</style>
    <style>${appStyles}</style>
    ${options.hidePrompt ? "<style>.prompt-area{display:none!important}</style>" : ""}
    ${renderReplayStyle(replay)}
  </head>
  <body${replay.enabled ? ' data-replay="true"' : ""}>
    <div class="app-shell">

      <!-- Mobile overlay -->
      <div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>

      <!-- Sidebar -->
      <aside class="sidebar" id="sidebar">
        <a class="sidebar-logo" href="/">
          <div class="sidebar-logo-mark">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <span class="sidebar-logo-text">FlowChat</span>
        </a>
        <div class="sidebar-body">
          <a class="sidebar-new-chat" href="/">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New chat
          </a>
          <div class="sidebar-label">This session</div>
          <a class="sidebar-item active" href="${escapeAttribute(`/c/${encodeURIComponent(options.chatId)}`)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            ${escapeHtml(chatLabel)}
          </a>
          ${isFork ? `<a class="sidebar-item" href="${escapeAttribute(`/c/${encodeURIComponent(options.forkId)}/fork`)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
            Open source fork
          </a>` : ""}
        </div>
        <div class="sidebar-footer">
          <a class="sidebar-item" href="${escapeAttribute(`/c/${encodeURIComponent(options.chatId)}/debug`)}" target="_blank">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            Debug view
          </a>
        </div>
      </aside>

      <!-- Main -->
      <div class="main-area">
        <header class="topbar">
          <button class="mobile-menu-btn" onclick="openSidebar()" aria-label="Menu">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span class="topbar-title">${escapeHtml(chatLabel)}</span>
          <div class="topbar-actions">
            <a class="topbar-btn" href="${escapeAttribute(`/c/${encodeURIComponent(options.chatId)}/fork`)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
              Fork
            </a>
            <a class="topbar-btn" href="${escapeAttribute(`/c/${encodeURIComponent(options.chatId)}?undo=1`)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>
              Undo
            </a>
            <a class="topbar-btn" href="${escapeAttribute(`/c/${encodeURIComponent(options.chatId)}/debug`)}" target="_blank">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              Debug
            </a>
          </div>
        </header>

        ${body}
      </div>
    </div>

    <script>
      function openSidebar() {
        document.getElementById('sidebar').classList.add('open');
        document.getElementById('sidebar-overlay').classList.add('open');
      }
      function closeSidebar() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('open');
      }

      // Enforce opaque shell backgrounds — runs after every style injection
      // Inline style always beats any stylesheet rule, even !important ones
      function lockShellBg() {
        var BG  = '#06091a';
        var S0  = '#080d20';
        function pin(sel, color) {
          var el = document.querySelector(sel);
          if (!el) return;
          el.style.setProperty('background',       color,  'important');
          el.style.setProperty('background-image', 'none', 'important');
          el.style.setProperty('background-color', color,  'important');
        }
        pin('.app-shell',   BG);
        pin('.main-area',   BG);
        pin('.sidebar',     S0);
        pin('.topbar',      S0);
        pin('.prompt-area', S0);
        // Lock html and body so model can't use them as backgrounds
        document.documentElement.style.setProperty('background', BG, 'important');
        document.documentElement.style.setProperty('background-image', 'none', 'important');
        document.body.style.setProperty('background', BG, 'important');
        document.body.style.setProperty('background-image', 'none', 'important');
        // Remove any rogue fixed/absolute full-page divs injected outside #fc-bg-layer
        document.querySelectorAll('body > div:not(.app-shell):not(#fc-bg-layer):not([id^="fc-"])').forEach(function(el) {
          var s = window.getComputedStyle(el);
          if ((s.position === 'fixed' || s.position === 'absolute') && s.zIndex > 0) {
            el.style.setProperty('z-index', '-1', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
          }
        });
      }
      lockShellBg();
      var _bgObserver = new MutationObserver(lockShellBg);
      _bgObserver.observe(document.head, { childList: true, subtree: true });
      _bgObserver.observe(document.body, { childList: true, attributes: true, attributeFilter: ['style'] });
    </script>
    <script>${renderClientRuntime(options.chatId, options.clientId, options.clientSecret, options.history, options.connect ?? true, options.interceptSubmits ?? false, replay)}</script>
  </body>
</html>`;
}

function renderReplayStyle(replay: ReplayPageOptions): string {
  if (!replay.enabled) return "";

  const styles = [`.message-agent[data-replay-keys-hidden="true"] { display: none !important; }`];

  if (replay.agentDisplay) {
    const duration = Math.max(replay.agentDelay, 1);
    styles.push(`
@keyframes flowchatReplayAgentDisplayShow {
  0% { display: none; } 99.999% { display: none; } 100% { display: ${replay.agentDisplay}; }
}
body[data-replay] .message-agent {
  animation: flowchatReplayAgentDisplayShow ${duration}ms step-end forwards;
}`);
  } else if (replay.agentDelay > 0) {
    styles.push(`
@keyframes flowchatReplayAgentShow {
  from { opacity: 0; } to { opacity: 1; }
}
body[data-replay] .message-agent {
  opacity: 0;
  animation: flowchatReplayAgentShow 1ms linear forwards;
  animation-delay: ${replay.agentDelay}ms;
}`);
  }

  return `<style>${styles.join("\n")}</style>`;
}

function renderClientSessionRedirect(chatId: string): string {
  return `
(() => {
  const chatId = ${jsonForInlineScript(chatId)};
  const key = "flowchat:chat:" + chatId;
  const stored = sessionStorage.getItem(key);
  const url = new URL(window.location.href);
  if (!stored || url.searchParams.has("clientId") || url.searchParams.has("clientSecret")) return;
  try {
    const session = JSON.parse(stored);
    if (!session?.clientId || !session?.clientSecret) return;
    url.searchParams.set("clientId", session.clientId);
    url.searchParams.set("clientSecret", session.clientSecret);
    window.location.replace(url.toString());
  } catch { sessionStorage.removeItem(key); }
})();`;
}

function renderClientRuntime(
  chatId: string,
  clientId: string,
  clientSecret: string,
  history: ClientUpdateTurn[],
  connectToSocket: boolean,
  interceptSubmits: boolean,
  replay: ReplayPageOptions,
): string {
  return `
(() => {
  const chatId = ${jsonForInlineScript(chatId)};
  const clientId = ${jsonForInlineScript(clientId)};
  const clientSecret = ${jsonForInlineScript(clientSecret)};
  const historyTurns = ${jsonForInlineScript(history)};
  const connectToSocket = ${jsonForInlineScript(connectToSocket)};
  const interceptSubmits = ${jsonForInlineScript(interceptSubmits)};
  const replayConfig = ${jsonForInlineScript(replay)};
  const replayParams = new URL(window.location.href).searchParams;
  const replayKeyMode = replayParams.get("replay") === "keys";
  const replayMode = replayConfig.enabled || replayParams.has("replay") || replayParams.has("wpm") || replayParams.has("pause") || replayParams.has("agentdelay") || replayParams.has("agentdisplay") || replayParams.has("agentduration") || replayParams.has("replaylimit") || replayParams.has("turn") || replayParams.has("up");
  const replayWpm = clampNumber(Number.parseFloat(replayParams.get("wpm") || "40"), 1, 400);
  const replayStartTurn = Math.floor(clampNumber(Number.parseFloat(replayParams.get("turn") || replayConfig.turn || "0"), 0, historyTurns.length));
  const replayPause = replayConfig.pause;
  const replayAgentDelay = replayConfig.agentDelay;
  const replayAgentDuration = replayConfig.agentDuration;
  const subscriptions = new Set();
  const activatedScriptPromises = [];
  const dynamicScriptLoads = new Map();
  let replayingHistory = true;
  let suppressAutoScroll = false;
  let replayKeyPresses = 0;
  const replayKeyWaiters = [];
  const sessionStorageKey = "flowchat:chat:" + chatId;
  sessionStorage.setItem(sessionStorageKey, JSON.stringify({ clientId, clientSecret }));

  if (replayKeyMode) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "Right" && event.code !== "ArrowRight") return;
      event.preventDefault();
      const waiter = replayKeyWaiters.shift();
      if (waiter) { waiter(); } else { replayKeyPresses += 1; }
    }, true);
  }

  const cleanUrl = new URL(window.location.href);
  if (cleanUrl.searchParams.has("clientId") || cleanUrl.searchParams.has("clientSecret")) {
    cleanUrl.searchParams.delete("clientId");
    cleanUrl.searchParams.delete("clientSecret");
    window.history.replaceState(null, "", cleanUrl.toString());
  }

  class Subscription {
    constructor(match, handler) { this.match = match; this.handler = handler; }
  }

  function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  const dispatch = (event) => {
    for (const subscription of subscriptions) {
      if (subscription.match(event)) subscription.handler(event);
    }
  };

  const processingInstructionText = (node) => {
    if (node.nodeType === Node.COMMENT_NODE) return node.data.replace(/^\\?(start|end|marker)\\b/i, (m) => m.toLowerCase());
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) return "?" + node.target.toLowerCase() + (node.data ? " " + node.data : "");
    return "";
  };

  const instructionNameMatches = (text, name) => {
    const escaped = name.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&");
    return new RegExp("\\\\bname\\\\s*=\\\\s*([\\"'])?" + escaped + "\\\\1").test(text);
  };

  const loadDynamicScript = (inertScript) => {
    const src = inertScript.src || inertScript.getAttribute("src");
    if (!src) return Promise.resolve();
    const url = new URL(src, window.location.href).toString();
    const existing = dynamicScriptLoads.get(url);
    if (existing) return existing;
    const promise = new Promise((resolve) => {
      const script = document.createElement("script");
      for (const attribute of inertScript.attributes) script.setAttribute(attribute.name, attribute.value);
      script.async = false;
      const timeout = window.setTimeout(() => { console.warn("Dynamic script timed out", url); resolve(); }, 15000);
      const finish = () => { window.clearTimeout(timeout); resolve(); };
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", () => { console.warn("Dynamic script failed", url); finish(); }, { once: true });
      document.head.append(script);
    });
    dynamicScriptLoads.set(url, promise);
    return promise;
  };

  const externalScriptsIn = (root) => {
    const scripts = root.querySelectorAll ? Array.from(root.querySelectorAll("script[src]")) : [];
    const templates = root.querySelectorAll ? Array.from(root.querySelectorAll("template")) : [];
    for (const template of templates) scripts.push(...externalScriptsIn(template.content));
    return scripts;
  };

  const preloadExternalScripts = async (root) => {
    for (const script of externalScriptsIn(root)) { await loadDynamicScript(script); script.remove(); }
  };

  const activateScripts = (root) => {
    const scripts = root.querySelectorAll ? root.querySelectorAll("script") : [];
    for (const inertScript of scripts) {
      const script = document.createElement("script");
      for (const attribute of inertScript.attributes) script.setAttribute(attribute.name, attribute.value);
      if (script.src) { script.async = false; activatedScriptPromises.push(loadDynamicScript(inertScript)); inertScript.remove(); continue; }
      script.text = inertScript.textContent || "";
      inertScript.replaceWith(script);
    }
    return root;
  };

  const activeClone = (content) => activateScripts(content.cloneNode(true));

  const replaceMarker = (name, content) => {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION);
    let start = null, depth = 0, startDepth = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = processingInstructionText(node);
      if (!text) continue;

      if (text.toLowerCase().startsWith("?marker") && instructionNameMatches(text, name)) {
        node.replaceWith(activeClone(content)); return true;
      }

      if (text.toLowerCase().startsWith("?start")) {
        depth += 1;
        if (!start && instructionNameMatches(text, name)) { start = node; startDepth = depth; }
        continue;
      }

      if (text.toLowerCase().startsWith("?end") && start) {
        if (depth <= startDepth) {
          const end = start.parentElement === node.parentElement ? node : null;
          let next = start.nextSibling;
          while (next) {
            if (next === end) { next.remove(); break; }
            const remove = next; next = next.nextSibling; remove.remove();
          }
          start.replaceWith(activeClone(content)); return true;
        }
        if (depth > 1) depth -= 1;
      }
    }
    return false;
  };

  const appendRawHtml = (html) => {
    const container = document.createElement("template");
    container.innerHTML = html;
    document.body.append(activeClone(container.content));
  };

  const waitForActivatedScripts = async (startIndex) => {
    const scripts = activatedScriptPromises.slice(startIndex);
    if (scripts.length > 0) await Promise.all(scripts);
  };

  const applyHtmlUpdate = async (html) => {
    const scriptStartIndex = activatedScriptPromises.length;
    const container = document.createElement("template");
    container.innerHTML = html;
    await preloadExternalScripts(container.content);
    const templates = Array.from(container.content.querySelectorAll("template[for]"));
    for (const template of templates) {
      const name = template.getAttribute("for");
      if (name && replaceMarker(name, template.content)) template.remove();
    }
    if (container.content.textContent.trim() || container.content.children.length > 0) {
      const wrapper = document.createElement("div");
      wrapper.append(container.content.cloneNode(true));
      appendRawHtml(wrapper.innerHTML);
    }
    await waitForActivatedScripts(scriptStartIndex);
  };

  const scrollToBottom = (behavior = "smooth") => {
    const viewport = document.getElementById("chat-viewport");
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    else document.documentElement.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  };

  const appendLocalAgentMessage = (text) => {
    const chat = document.getElementById("chat-messages");
    if (!chat) return;
    const message = document.createElement("div");
    message.className = "message message-agent";
    message.textContent = text;
    chat.append(message);
    requestAnimationFrame(() => scrollToBottom());
  };

  if (interceptSubmits) {
    document.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      appendLocalAgentMessage("To chat you need an account with permission. You can deploy your own copy to Cloudflare from GitHub.");
    }, true);
  }

  // Normalize any form action the LLM writes without a leading slash
  // Also show typing indicator for in-chat form submissions (TTT moves etc.)
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.getAttribute("action") || "";
    if (action && !action.startsWith("/") && !action.startsWith("http")) {
      form.setAttribute("action", "/" + action);
    }
    // Show typing for any form that targets the hidden frame (game moves etc.)
    if (form.target === "hidden-submit-frame" && form.id !== "prompt-form") {
      const typing = document.getElementById("fc-typing");
      if (!typing) {
        const chat = document.getElementById("chat-messages");
        if (chat) {
          const t = document.createElement("div");
          t.className = "typing-indicator";
          t.id = "fc-typing";
          t.innerHTML = "<div class='typing-dot'></div><div class='typing-dot'></div><div class='typing-dot'></div>";
          chat.appendChild(t);
          const vp = document.getElementById("chat-viewport");
          if (vp) vp.scrollTop = vp.scrollHeight;
        }
      }
      setTimeout(() => {
        const t = document.getElementById("fc-typing");
        if (t) t.remove();
      }, 30000);
    }
  }, true);

  // Remove optimistic bubble and typing indicator when first real update arrives
  function removeOptimisticUI() {
    document.querySelectorAll(".optimistic").forEach((el) => el.remove());
    const typing = document.getElementById("fc-typing");
    if (typing) typing.remove();
  }

  window.Subscription = Subscription;
  window.partialupdates = { clientId, subscribe(sub) { subscriptions.add(sub); return () => subscriptions.delete(sub); }, dispatch };

  window.partialupdates.subscribe(new Subscription(
    (update) => update.path === "/body" && update.type === "html",
    async (update) => {
      removeOptimisticUI();
      await applyHtmlUpdate(update.payload);
      if (suppressAutoScroll) return;
      requestAnimationFrame(() => scrollToBottom());
    }
  ));

  window.partialupdates.subscribe(new Subscription(
    (update) => !replayingHistory && update.path === "/page/reload" && update.type === "json",
    () => window.location.reload()
  ));

  const sleep = (delay) => new Promise((resolve) => window.setTimeout(resolve, delay));
  const nextPaint = () => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); });
  const waitForReplayKey = () => {
    if (replayKeyPresses > 0) { replayKeyPresses -= 1; return Promise.resolve(); }
    return new Promise((resolve) => { replayKeyWaiters.push(resolve); });
  };

  const promptTextarea = () => {
    const p = document.querySelector('textarea[name="prompt"]');
    return p instanceof HTMLTextAreaElement ? p : null;
  };

  const setPromptValue = (value) => {
    const p = promptTextarea();
    if (!p) return;
    p.value = value;
    p.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const currentReplayPromptLimit = () => {
    const params = new URL(window.location.href).searchParams;
    return params.has("replaylimit") ? clampNumber(Number.parseFloat(params.get("replaylimit") || "0"), 0, 1000000) : replayConfig.promptLimit;
  };

  const scrollPromptIntoView = () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()));
  };

  const currentReplayUpOffset = () => {
    const params = new URL(window.location.href).searchParams;
    return params.has("up") ? clampNumber(Number.parseFloat(params.get("up") || "0"), 0, 1000) : null;
  };

  const scrollReplayUserIntoView = (user) => {
    const offset = currentReplayUpOffset();
    if (!user || offset === null) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.scrollTo({ top: user.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
    }));
  };

  const typePromptText = async (text, holdInstantText = false) => {
    const p = promptTextarea();
    if (!p || !text) return "";
    p.focus({ preventScroll: true });
    let value = "";
    const averageDelay = 60000 / (replayWpm * 4);
    const characters = Array.from(text);
    const promptLimit = currentReplayPromptLimit();
    const typedCharacters = characters.slice(0, promptLimit);
    const instantCharacters = characters.slice(promptLimit);

    for (const character of typedCharacters) {
      value += character;
      setPromptValue(value);
      scrollToBottom("auto");
      await sleep(averageDelay * (0.4 + Math.random() * 1.2));
    }

    if (instantCharacters.length > 0) {
      if (holdInstantText) return value + instantCharacters.join("");
      setPromptValue(value + instantCharacters.join(""));
      scrollToBottom("auto");
    }
    return "";
  };

  const hiddenReplayAgents = [];
  const replayUsers = [];

  const dispatchTurn = (turn, options = {}) => {
    const knownAgents = new Set(document.querySelectorAll(".message-agent"));
    const knownUsers = new Set(document.querySelectorAll(".message-user"));
    for (const update of turn.updates) dispatch(update);

    if (!replayKeyMode || options.revealAgents) return;

    for (const agent of document.querySelectorAll(".message-agent")) {
      if (!knownAgents.has(agent)) { agent.dataset.replayKeysHidden = "true"; hiddenReplayAgents.push(agent); }
    }
    for (const user of document.querySelectorAll(".message-user")) {
      if (!knownUsers.has(user)) replayUsers.push(user);
    }
  };

  const revealReplayAgents = () => {
    for (const agent of hiddenReplayAgents.splice(0)) delete agent.dataset.replayKeysHidden;
  };

  const replayHistory = async () => {
    if (!replayMode) {
      for (const turn of historyTurns) for (const update of turn.updates) dispatch(update);
      return;
    }

    if (historyTurns.length > 0) await nextPaint();

    if (replayStartTurn > 0) {
      for (const turn of historyTurns.slice(0, replayStartTurn)) dispatchTurn(turn, { revealAgents: true });
      await nextPaint();
    }

    if (replayKeyMode) {
      for (let index = replayStartTurn; index < historyTurns.length; index += 1) {
        const turn = historyTurns[index];
        const userText = turn.prompt || "";
        if (userText) {
          await waitForReplayKey();
          const limitedText = await typePromptText(userText, true);
          if (limitedText) { await waitForReplayKey(); setPromptValue(limitedText); }
        }
        await waitForReplayKey();
        suppressAutoScroll = true; setPromptValue(""); dispatchTurn(turn); suppressAutoScroll = false;
        await waitForReplayKey(); revealReplayAgents(); scrollReplayUserIntoView(replayUsers.shift());
        await waitForReplayKey(); scrollPromptIntoView();
      }
      return;
    }

    for (let index = replayStartTurn; index < historyTurns.length; index += 1) {
      const turn = historyTurns[index];
      const userText = turn.prompt || "";
      if (userText) { await typePromptText(userText); await sleep(replayPause); setPromptValue(""); }
      dispatchTurn(turn);
      if (index < historyTurns.length - 1) await sleep(replayAgentDelay + replayAgentDuration);
    }
  };

  let reconnectDelay = 1000;
  let reconnectTimer = 0;
  let socket = null;

  const socketIsOpenOrOpening = () => socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;

  const scheduleReconnect = () => {
    window.clearTimeout(reconnectTimer);
    if (!connectToSocket || document.visibilityState !== "visible" || socketIsOpenOrOpening()) return;
    const jitter = Math.floor(Math.random() * 500);
    reconnectTimer = window.setTimeout(() => { connect(); reconnectDelay = Math.min(reconnectDelay * 2, 30000); }, reconnectDelay + jitter);
  };

  const connect = () => {
    if (!connectToSocket || document.visibilityState !== "visible" || socketIsOpenOrOpening()) return;
    const url = new URL("/c/" + encodeURIComponent(chatId) + "/socket", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", clientId);
    url.searchParams.set("clientSecret", clientSecret);
    socket = new WebSocket(url);
    let pingTimer;

    socket.addEventListener("open", () => {
      reconnectDelay = 1000;
      pingTimer = window.setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send("ping"); }, 25000);
    });

    socket.addEventListener("message", (message) => {
      if (message.data === "pong") return;
      try { dispatch(JSON.parse(message.data)); } catch (error) { console.warn("Invalid update", error); }
    });

    socket.addEventListener("close", () => {
      window.clearInterval(pingTimer); socket = null; scheduleReconnect();
    });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { reconnectDelay = 1000; scheduleReconnect(); }
  });

  replayHistory().finally(() => {
    replayingHistory = false;
    if (connectToSocket) connect();
  });
})();`;
}

// ──────────────────────────── Routing ────────────────────────────────────────

function canonicalChatUrl(
  url: URL,
  route: { kind: "chat" | "fork" | "socket" | "debug" | "debugClear" | "prompt" | "form"; chatId: string },
): URL {
  const canonical = new URL(canonicalChatPath(route), url.origin);
  canonical.search = url.search;
  return canonical;
}

function canonicalChatPath(
  route: { kind: "chat" | "fork" | "socket" | "debug" | "debugClear" | "prompt" | "form"; chatId: string },
): string {
  switch (route.kind) {
    case "chat": return chatPath(route.chatId);
    case "fork": return chatPath(route.chatId, "fork");
    case "socket": return chatPath(route.chatId, "socket");
    case "debug": return chatPath(route.chatId, "debug");
    case "debugClear": return chatPath(route.chatId, "debug", "clear");
    case "prompt": return chatPath(route.chatId, "prompt");
    case "form": return chatPath(route.chatId, "form");
  }
}

function parseRoute(
  pathname: string,
):
  | { kind: "home" }
  | { kind: "chat"; chatId: string; legacy: boolean }
  | { kind: "fork"; chatId: string; legacy: boolean }
  | { kind: "socket"; chatId: string; legacy: boolean }
  | { kind: "debug"; chatId: string; legacy: boolean }
  | { kind: "debugClear"; chatId: string; legacy: boolean }
  | { kind: "prompt"; chatId: string; legacy: boolean }
  | { kind: "form"; chatId: string; legacy: boolean }
  | { kind: "unknown" } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "home" };
  if (parts[0] === "c") return parseChatRoute(parts.slice(1), false);
  return parseChatRoute(parts, true);
}

function parseChatRoute(
  parts: string[],
  legacy: boolean,
):
  | { kind: "chat"; chatId: string; legacy: boolean }
  | { kind: "fork"; chatId: string; legacy: boolean }
  | { kind: "socket"; chatId: string; legacy: boolean }
  | { kind: "debug"; chatId: string; legacy: boolean }
  | { kind: "debugClear"; chatId: string; legacy: boolean }
  | { kind: "prompt"; chatId: string; legacy: boolean }
  | { kind: "form"; chatId: string; legacy: boolean }
  | { kind: "unknown" } {
  if (parts.length === 1 && isSafeId(parts[0])) return { kind: "chat", chatId: parts[0], legacy };
  if (parts.length === 2 && isSafeId(parts[0])) {
    if (parts[1] === "fork") return { kind: "fork", chatId: parts[0], legacy };
    if (parts[1] === "socket") return { kind: "socket", chatId: parts[0], legacy };
    if (parts[1] === "debug") return { kind: "debug", chatId: parts[0], legacy };
    if (parts[1] === "prompt") return { kind: "prompt", chatId: parts[0], legacy };
    if (parts[1] === "form") return { kind: "form", chatId: parts[0], legacy };
  }
  if (parts.length === 3 && isSafeId(parts[0]) && parts[1] === "debug" && parts[2] === "clear") {
    return { kind: "debugClear", chatId: parts[0], legacy };
  }
  return { kind: "unknown" };
}

function chatPath(chatId: string, ...parts: string[]): string {
  const encoded = [chatId, ...parts].map((part) => encodeURIComponent(part));
  return `/c/${encoded.join("/")}`;
}

function isSafeId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function newChatId(): string { return crypto.randomUUID().slice(0, 8); }
function newClientSecret(): string { return crypto.randomUUID(); }
function newChatIdFromFork(): string { return newChatId(); }

function newForkClientSession(): ClientSession {
  return { clientId: `fork-${crypto.randomUUID().slice(0, 8)}`, clientSecret: newClientSecret() };
}

function newForkId(): string { return `fork-${crypto.randomUUID().slice(0, 8)}`; }

function maxClientId(messages: ChatMessage[]): number {
  return messages.reduce((max, message) => {
    const parsed = Number.parseInt(message.clientId, 10);
    return Number.isFinite(parsed) && parsed >= max ? parsed : max;
  }, 0);
}

function parseUndoCount(value: string | null): number {
  if (!value) return 0;
  return normalizeUndoCount(Number.parseInt(value, 10));
}

function normalizeUndoCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 100) : 0;
}

function defaultReplayPageOptions(): ReplayPageOptions {
  return { agentDelay: 0, agentDisplay: "", agentDuration: 500, enabled: false, pause: 500, promptLimit: REPLAY_PROMPT_LIMIT_MAX, turn: 0 };
}

function parseReplayPageOptions(params: URLSearchParams): ReplayPageOptions {
  const replayDelay = parseBoundedInteger(params.get("replay"), 0, 10000, 0);
  return {
    agentDelay: parseBoundedInteger(params.get("agentdelay"), 0, 60000, 0),
    agentDisplay: parseAgentDisplay(params.get("agentdisplay")),
    agentDuration: parseBoundedInteger(params.get("agentduration"), 0, 60000, 500),
    enabled: replayDelay > 0 || params.has("replay") || params.has("wpm") || params.has("pause") || params.has("agentdelay") || params.has("agentdisplay") || params.has("agentduration") || params.has("replaylimit") || params.has("turn"),
    pause: parseBoundedInteger(params.get("pause"), 0, 60000, replayDelay > 0 ? replayDelay : 500),
    promptLimit: parseReplayLimit(params.get("replaylimit")),
    turn: parseBoundedInteger(params.get("turn"), 0, 1000, 0),
  };
}

function parseReplayLimit(value: string | null): number {
  return value === null ? REPLAY_PROMPT_LIMIT_MAX : parseBoundedInteger(value, 0, REPLAY_PROMPT_LIMIT_MAX, 0);
}

function parseAgentDisplay(value: string | null): ReplayPageOptions["agentDisplay"] {
  return value === "block" || value === "flex" || value === "grid" ? value : "";
}

function parseBoundedInteger(value: string | null, min: number, max: number, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function envFlagEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

function emptyRateLimitState(): RateLimitState {
  return { active: [], newChats: [], prompts: [] };
}

function rateLimitsForScope(scope: RateLimitScope) {
  if (scope === "ip") {
    return { active: IP_MAX_ACTIVE_LLM_REQUESTS, newChatsPerHour: IP_MAX_NEW_CHATS_PER_HOUR, promptsPerHour: IP_MAX_PROMPTS_PER_HOUR, promptsPerMinute: IP_MAX_PROMPTS_PER_MINUTE };
  }
  return { active: BROWSER_MAX_ACTIVE_LLM_REQUESTS, newChatsPerHour: BROWSER_MAX_NEW_CHATS_PER_HOUR, promptsPerHour: BROWSER_MAX_PROMPTS_PER_HOUR, promptsPerMinute: BROWSER_MAX_PROMPTS_PER_MINUTE };
}

function retryAfterSeconds(timestamp: number, baseline: number): number {
  return Math.max(1, Math.ceil((timestamp - baseline) / 1000));
}

// ──────────────────────────── Crypto helpers ─────────────────────────────────

async function hashRateLimitKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return valueParts.join("=") || undefined;
  }
  return undefined;
}

async function signBrowserRateLimitCookie(browserId: string, secret: string): Promise<string> {
  const signature = await hmacSha256(browserId, secret);
  return `${browserId}.${base64UrlEncode(signature)}`;
}

async function verifyBrowserRateLimitCookie(value: string, secret: string): Promise<string | undefined> {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const browserId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^[a-f0-9-]{36}$/i.test(browserId)) return undefined;
  const expected = base64UrlEncode(await hmacSha256(browserId, secret));
  return constantTimeEqual(signature, expected) ? browserId : undefined;
}

async function hmacSha256(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function serializeBrowserRateLimitCookie(value: string, secure: boolean): string {
  return [`${RATE_LIMIT_COOKIE_NAME}=${value}`, "HttpOnly", "Max-Age=31536000", "Path=/", "SameSite=Lax", secure ? "Secure" : ""]
    .filter(Boolean).join("; ");
}

// ──────────────────────────── Misc helpers ───────────────────────────────────

function promptMaxCharacters(env: AppEnv): number {
  const configured = numberEnv(env.PROMPT_MAX_CHARACTERS, PROMPT_MAX_CHARACTERS_DEFAULT);
  return configured > 0 ? Math.floor(configured) : PROMPT_MAX_CHARACTERS_DEFAULT;
}

function characterCount(value: string): number { return Array.from(value).length; }

function getFormString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function formDataToRecord(form: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of form.entries()) record[key] = typeof value === "string" ? value : value.name;
  return record;
}

function injectPageIds(html: string, chatId: string, clientId: string, clientSecret: string, forkId: string): string {
  return injectServerReplacements(html, chatId, clientId, clientSecret, forkId);
}

// ──────────────────────────── Protocol helpers ───────────────────────────────

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function* streamModelResponse(env: AppEnv, messages: LlmMessage[], clientId: string): AsyncIterable<string> {
  const provider = env.MODEL_PROVIDER || "cloudflare-gateway";
  const fallbackPrompt = lastUserMessage(messages);

  if (provider === "gemini-direct" && env.GEMINI_API_KEY) { yield* streamGeminiResponse(env, messages); return; }
  if (provider === "inception-direct" && env.INCEPTION_API_KEY) { yield* streamInceptionResponse(env, messages); return; }
  if (provider === "workers-ai" && env.AI) { yield* streamWorkersAiResponse(env, messages); return; }
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) { yield* streamCloudflareGatewayResponse(env, messages); return; }
  if (env.GEMINI_API_KEY) { yield* streamGeminiResponse(env, messages); return; }

  yield fallbackUpdate(fallbackPrompt, clientId);
}

async function* streamCloudflareGatewayResponse(env: AppEnv, messages: LlmMessage[]): AsyncIterable<string> {
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID || "default";
  const model = env.CLOUDFLARE_AI_GATEWAY_MODEL || "google/gemini-3-flash";
  const modelSettings = parseGatewayModelSettings(env.CLOUDFLARE_AI_GATEWAY_MODEL_SETTINGS);
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || "")}/ai/v1/chat/completions`;
  const response = await fetch(url, {
    body: JSON.stringify({ ...modelSettings, messages: gatewayChatMessagesFromMessages(messages), model, stream: true }),
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN || ""}`, "Content-Type": "application/json", "cf-aig-gateway-id": gatewayId },
    method: "POST",
  });

  if (!response.ok || !response.body) {
    console.warn("Cloudflare Gateway error", { model, status: response.status, body: await response.text().catch(() => "") });
    yield fallbackUpdate(lastUserMessage(messages), "");
    return;
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("text/event-stream")) { yield* parseSseTextStream(response.body); return; }
  yield extractTextFromPayload(await response.json().catch(() => undefined)) || fallbackUpdate(lastUserMessage(messages), "");
}

async function* streamWorkersAiResponse(env: AppEnv, messages: LlmMessage[]): AsyncIterable<string> {
  if (!env.AI) { yield fallbackUpdate(lastUserMessage(messages), ""); return; }

  let stream: unknown;

  try {
    const model = env.WORKERS_AI_MODEL || "@cf/zai-org/glm-4.7-flash";
    stream = await env.AI.run(model, { messages, stream: true }, env.CLOUDFLARE_AI_GATEWAY_ID ? { gateway: { id: env.CLOUDFLARE_AI_GATEWAY_ID } } : undefined);
  } catch {
    yield fallbackUpdate(lastUserMessage(messages), ""); return;
  }

  if (stream instanceof ReadableStream) { yield* parseSseTextStream(stream); return; }
  yield extractTextFromPayload(stream) || fallbackUpdate(lastUserMessage(messages), "");
}

async function* streamGeminiResponse(env: AppEnv, messages: LlmMessage[]): AsyncIterable<string> {
  const model = env.GEMINI_MODEL || "gemini-3-flash-preview";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(env.GEMINI_API_KEY || "")}`,
    {
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") }] }] }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok || !response.body) {
    console.warn("Gemini error", { model, status: response.status });
    yield fallbackUpdate(lastUserMessage(messages), ""); return;
  }

  yield* parseSseTextStream(response.body);
}

async function* streamInceptionResponse(env: AppEnv, messages: LlmMessage[]): AsyncIterable<string> {
  const model = env.INCEPTION_MODEL || "mercury-2";
  const response = await fetch("https://api.inceptionlabs.ai/v1/chat/completions", {
    body: JSON.stringify({
      messages: gatewayChatMessagesFromMessages(messages),
      model,
      reasoning_effort: env.INCEPTION_REASONING_EFFORT || "medium",
      temperature: numberEnv(env.INCEPTION_TEMPERATURE, 0.75),
      max_tokens: numberEnv(env.INCEPTION_MAX_TOKENS, 8192),
    }),
    headers: { Authorization: `Bearer ${env.INCEPTION_API_KEY || ""}`, "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok || !response.body) {
    console.warn("Inception error", { model, status: response.status });
    yield fallbackUpdate(lastUserMessage(messages), ""); return;
  }

  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("text/event-stream")) { yield* parseSseTextStream(response.body); return; }
  yield extractTextFromPayload(await response.json().catch(() => undefined)) || fallbackUpdate(lastUserMessage(messages), "");
}

function lastUserMessage(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function promptTextFromLlmUserMessage(content: string): string {
  const form = content.match(/^\[form\]:(.*)$/s);
  if (form) return new URLSearchParams(form[1]).get("prompt") || "";
  const clientPrompt = content.match(/^\[[^\]]+\]:(.*)$/s);
  return clientPrompt ? clientPrompt[1] : content;
}

function formatClientPrompt(clientId: string, prompt: string): string { return `[${clientId}]:${prompt}`; }

function formatFormPrompt(fields: Record<string, string>): string {
  const visibleFields = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "clientSecret"));
  return `[form]:${new URLSearchParams(visibleFields).toString()}`;
}

function gatewayChatMessagesFromMessages(messages: LlmMessage[]) {
  return messages.map((message) => ({ content: message.content, role: message.role }));
}

function parseGatewayModelSettings(value: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { console.warn("Invalid gateway model settings"); return {}; }
  const settings = { ...(parsed as Record<string, unknown>) };
  for (const k of ["messages", "model", "stream"]) delete settings[k];
  return settings;
}

function numberEnv(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Number(value); if (Number.isFinite(parsed)) return parsed; }
  return fallback;
}

async function* parseSseTextStream(stream: ReadableStream): AsyncIterable<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try { const text = extractTextFromPayload(JSON.parse(data)); if (text) yield text; } catch { continue; }
    }
  }
}

function extractTextFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string }>;
    response?: string;
    result?: unknown;
  };
  return (
    data.choices?.map((c) => c.delta?.content || c.message?.content || c.text || "").join("") ||
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
    data.response ||
    extractTextFromPayload(data.result) ||
    ""
  );
}

// ──────────────────────────── Update stream parser ───────────────────────────

class UpdateStreamParser {
  private buffer = "";

  push(chunk: string): Update[] {
    this.buffer += chunk;
    const updates: Update[] = [];
    while (true) { const parsed = this.parseNext(false); if (!parsed) return updates; updates.push(parsed); }
  }

  finish(): Update[] {
    const updates: Update[] = [];
    while (this.buffer.trim()) { const parsed = this.parseNext(true); if (!parsed) break; updates.push(parsed); }
    return updates;
  }

  private parseNext(final: boolean): Update | null {
    this.buffer = this.buffer.trimStart();
    if (!this.buffer) return null;

    const bodyEnd = findDelimiterLine(this.buffer, BODY_END);

    if (bodyEnd === -1) {
      if (!final || containsProtocolDelimiter(this.buffer)) return null;
      return this.parseLegacyNext(final);
    }

    const endOfMessage = bodyEnd + BODY_END.length;
    const candidate = this.buffer.slice(0, endOfMessage);
    const parsed = parseDelimitedUpdate(candidate);
    this.buffer = this.buffer.slice(endOfMessage);
    this.consumeSplitMessage();
    return parsed;
  }

  private parseLegacyNext(final: boolean): Update | null {
    const end = findJsonObjectEnd(this.buffer);
    if (end === -1) { if (final) this.buffer = ""; return null; }
    const candidate = this.buffer.slice(0, end + 1);
    const parsed = coerceUpdate(parseJson(candidate));
    this.buffer = this.buffer.slice(end + 1);
    return parsed;
  }

  private consumeSplitMessage(): void {
    this.buffer = this.buffer.trimStart();
    if (this.buffer.startsWith(SPLIT_MESSAGE)) this.buffer = this.buffer.slice(SPLIT_MESSAGE.length);
  }
}

function parseAllUpdates(text: string): Update[] {
  const parser = new UpdateStreamParser();
  return [...parser.push(text), ...parser.finish()];
}

function parseDelimitedUpdate(text: string): Update | null {
  const body = readDelimitedSection(text, BODY_START, BODY_END);
  if (body === null) return null;
  const serverProps = parseLooseObject(readDelimitedSection(text, SERVER_PROPS_START, SERVER_PROPS_END));
  const clientProps = parseLooseObject(readDelimitedSection(text, CLIENT_PROPS_START, CLIENT_PROPS_END));
  return coerceDelimitedUpdate(serverProps, clientProps, body);
}

function readDelimitedSection(text: string, startDelimiter: string, endDelimiter: string): string | null {
  const start = findDelimiterLine(text, startDelimiter);
  if (start === -1) return null;
  const contentStart = lineEndIndex(text, start + startDelimiter.length);
  const end = findDelimiterLine(text, endDelimiter, contentStart);
  if (end === -1) return null;
  return trimOneLeadingAndTrailingLineBreak(text.slice(contentStart, end));
}

function findDelimiterLine(text: string, delimiter: string, fromIndex = 0): number {
  let index = text.indexOf(delimiter, fromIndex);
  while (index !== -1) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + delimiter.length] || "";
    if ((index === 0 || before === "\n" || before === "\r") && (after === "" || after === "\n" || after === "\r")) return index;
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}

function lineEndIndex(text: string, index: number): number {
  if (text[index] === "\r" && text[index + 1] === "\n") return index + 2;
  if (text[index] === "\n" || text[index] === "\r") return index + 1;
  return index;
}

function trimOneLeadingAndTrailingLineBreak(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function containsProtocolDelimiter(text: string): boolean {
  return text.includes(`${PROTOCOL_PREFIX}:`);
}

function findJsonObjectEnd(input: string): number {
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inString) {
      if (escaped) { escaped = false; } else if (char === "\\") { escaped = true; } else if (char === '"') { inString = false; }
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") { depth += 1; } else if (char === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }

function parseLooseObject(value: string | null): unknown {
  if (value === null || !value.trim()) return undefined;
  const parsed = parseJson(value);
  if (parsed !== undefined) return parsed;
  return parseJson(jsonishToJson(value));
}

function jsonishToJson(value: string): string {
  return value
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, content: string) => JSON.stringify(content.replace(/\\'/g, "'")))
    .replace(/,\s*([}\]])/g, "$1");
}

function coerceDelimitedUpdate(serverProps: unknown, clientProps: unknown, payload: string): Update {
  const server = serverProps && typeof serverProps === "object" ? (serverProps as { clients?: unknown }) : {};
  const client = clientProps && typeof clientProps === "object" ? (clientProps as { path?: unknown; type?: unknown }) : {};
  const clients = coerceClients(server.clients) ?? { mode: "exclude" as const, ids: [] };
  const type = client.type === "json" ? "json" : "html";
  const path = typeof client.path === "string" ? client.path : "/body";
  return { clients, path, payload, type };
}

function coerceUpdate(value: unknown): Update | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Update>;
  const clients = candidate.clients;
  if (!clients || typeof clients !== "object") return null;
  const coercedClients = coerceClients(clients);
  const type = candidate.type === "html" || candidate.type === "json" ? candidate.type : null;
  if (!coercedClients || !type || typeof candidate.path !== "string" || typeof candidate.payload !== "string") return null;
  return { clients: coercedClients, path: candidate.path, payload: candidate.payload, type };
}

function coerceClients(value: unknown): Update["clients"] | null {
  if (!value || typeof value !== "object") return null;
  const clients = value as { ids?: unknown; mode?: unknown; type?: unknown };
  const mode = clients.type === "include" || clients.type === "exclude" ? clients.type
    : clients.mode === "include" || clients.mode === "exclude" ? clients.mode : null;
  if (!mode || !Array.isArray(clients.ids)) return null;
  return { mode, ids: clients.ids.filter((id): id is string | number => typeof id === "string" || typeof id === "number").map(String) };
}

function shouldSendToClient(update: Update, clientId: string): boolean {
  if (update.clients.mode === "include") return update.clients.ids.includes(clientId);
  return !update.clients.ids.includes(clientId);
}

function toClientUpdate(update: Update, chatId: string, clientId: string, clientSecret: string, forkId: string): ClientUpdate {
  return { path: update.path, payload: injectServerReplacements(update.payload, chatId, clientId, clientSecret, forkId), type: update.type };
}

function toClientUpdateTurn(turn: ReplayTurn, chatId: string, clientId: string, clientSecret: string, forkId: string): ClientUpdateTurn {
  return {
    prompt: turn.prompt,
    updates: turn.updates
      .filter((update) => shouldSendToClient(update, clientId))
      .map((update) => toClientUpdate(update, chatId, clientId, clientSecret, forkId)),
  };
}

function injectServerReplacements(value: string, chatId: string, clientId: string, clientSecret: string, forkId: string): string {
  return value
    .replaceAll(CLIENT_ID_TOKEN, escapeAttribute(clientId))
    .replaceAll(CLIENT_SECRET_TOKEN, escapeAttribute(clientSecret))
    .replaceAll(CHAT_ID_TOKEN, escapeAttribute(chatId))
    .replaceAll(FORK_ID_TOKEN, escapeAttribute(forkId));
}

function formatDelimitedUpdate(update: Update): string {
  return [
    SERVER_PROPS_START,
    JSON.stringify({ clients: { type: update.clients.mode, ids: update.clients.ids } }, null, 2),
    SERVER_PROPS_END,
    CLIENT_PROPS_START,
    JSON.stringify({ path: update.path, type: update.type }, null, 2),
    CLIENT_PROPS_END,
    BODY_START,
    update.payload,
    BODY_END,
  ].join("\n");
}

function fallbackUpdate(prompt: string, fallbackClientId: string): string {
  const { clientId, text } = splitPrompt(prompt);
  const id = clientId || fallbackClientId;
  const update: Update = {
    clients: { mode: "exclude", ids: [] },
    path: "/body",
    payload: `<template for="/chat/append-message">
	<div class="message message-user" data-client-id="${escapeAttribute(id)}">${escapeHtml(text)}</div>
	<div class="message message-agent">I received your message, but the configured model provider did not return a response. Check the Cloudflare Gateway, Workers AI, Gemini, or Inception settings.</div>
	<?marker name="/chat/append-message">
</template>`,
    type: "html",
  };
  return formatDelimitedUpdate(update);
}

function splitPrompt(prompt: string): { clientId: string; text: string } {
  const match = prompt.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/) ?? prompt.match(/^([^:]+):\s*([\s\S]*)$/);
  if (!match) return { clientId: "", text: prompt };
  return { clientId: match[1], text: match[2] };
}

function sanitizeModelOutput(output: string): string { return output; }

function normalizeModelOutput(output: string, clientId: string): string {
  const escapedClientId = escapeRegExp(clientId);
  const pattern = new RegExp(`(<div\\b[^>]*class=["'][^"']*\\bmessage-user\\b[^"']*["'][^>]*data-client-id=["']${escapedClientId}["'][^>]*>\\s*)${escapedClientId}:\\s*`, "gi");
  return output.replace(pattern, "$1");
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeHtmlWithBreaks(value: string): string { return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>"); }

function escapeAttribute(value: string): string { return escapeHtml(value); }
