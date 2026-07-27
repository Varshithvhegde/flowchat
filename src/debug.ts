export type LlmRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type DebugState = {
  messages: LlmMessage[];
  objectId: string;
  updatedAt: string;
};

type DebugMode = "raw" | "pretty";
type HighlightLanguage = "json" | "html" | "text";

type ProtocolSection = {
  title: string;
  content: string;
  language: HighlightLanguage;
};

type ProtocolMessage = {
  sections: ProtocolSection[];
};

const PROTOCOL_PREFIX = "PpqUtcLGQdYN4oqc";
const SPLIT_MESSAGE = `${PROTOCOL_PREFIX}:SPLIT_MESSAGE`;
const SERVER_PROPS_START = `${PROTOCOL_PREFIX}:SERVER_PROPS_START`;
const SERVER_PROPS_END = `${PROTOCOL_PREFIX}:SERVER_PROPS_END`;
const CLIENT_PROPS_START = `${PROTOCOL_PREFIX}:CLIENT_PROPS_START`;
const CLIENT_PROPS_END = `${PROTOCOL_PREFIX}:CLIENT_PROPS_END`;
const BODY_START = `${PROTOCOL_PREFIX}:BODY_START`;
const BODY_END = `${PROTOCOL_PREFIX}:BODY_END`;

const htmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
};

export function renderDebugPage(url: URL, state: DebugState): Response {
  const mode = readDebugMode(url);
  const chatHref = new URL(chatPath(state.objectId), url.origin).toString();
  const clearAction = chatPath(state.objectId, "debug", "clear");
  const rawHref = debugModeHref(url, "raw");
  const prettyHref = debugModeHref(url, "pretty");

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>FlowChat Debug ${escapeHtml(state.objectId)}</title>
		<style>${debugStyles}</style>
	</head>
	<body>
		<header>
			<div>
				<h1>Debug: ${escapeHtml(state.objectId)}</h1>
				<p>Updated ${escapeHtml(state.updatedAt)}</p>
			</div>
			<div class="actions">
				<nav aria-label="Debug view mode">
					<a class="${mode === "raw" ? "active" : ""}" href="${escapeAttribute(rawHref)}">Raw</a>
					<a class="${mode === "pretty" ? "active" : ""}" href="${escapeAttribute(prettyHref)}">Pretty</a>
				</nav>
				<a href="${escapeAttribute(chatHref)}">Open chat</a>
				<form method="post" action="${escapeAttribute(clearAction)}">
					<button type="submit">Clear chat</button>
				</form>
			</div>
		</header>
		${mode === "pretty" ? renderPrettyState(state) : renderRawState(state)}
	</body>
</html>`,
    { headers: htmlHeaders },
  );
}

function readDebugMode(url: URL): DebugMode {
  return url.searchParams.get("mode") === "pretty" ? "pretty" : "raw";
}

function chatPath(chatId: string, ...parts: string[]): string {
  const encoded = [chatId, ...parts].map((part) => encodeURIComponent(part));
  return `/c/${encoded.join("/")}`;
}

function debugModeHref(url: URL, mode: DebugMode): string {
  const href = new URL(url.toString());
  href.searchParams.set("mode", mode);
  return href.toString();
}

function renderRawState(state: DebugState): string {
  return `<pre class="raw">${escapeHtml(JSON.stringify(state, null, 2))}</pre>`;
}

function renderPrettyState(state: DebugState): string {
  return `<main class="messages">${state.messages
    .map((message, index) => renderPrettyMessage(message, index))
    .join("")}</main>`;
}

function renderPrettyMessage(message: LlmMessage, index: number): string {
  const protocolMessages = parseProtocolMessages(message.content);

  return `<section class="message">
		<h2><span>${index + 1}</span>${escapeHtml(message.role)}</h2>
		${
      protocolMessages.length > 0
        ? protocolMessages
            .map((protocolMessage, messageIndex) =>
              renderProtocolMessage(protocolMessage, messageIndex),
            )
            .join("")
        : renderHighlightedBlock("content", message.content, "text")
    }
	</section>`;
}

function renderProtocolMessage(
  message: ProtocolMessage,
  messageIndex: number,
): string {
  return `<article class="protocol-message">
		<h3>Message ${messageIndex + 1}</h3>
		${message.sections
      .map((section) =>
        renderHighlightedBlock(section.title, section.content, section.language),
      )
      .join("")}
	</article>`;
}

function renderHighlightedBlock(
  title: string,
  content: string,
  language: HighlightLanguage,
): string {
  return `<section class="block">
		<h4>${escapeHtml(title)} <span>${language}</span></h4>
		<pre class="code ${language}">${highlight(content, language)}</pre>
	</section>`;
}

function parseProtocolMessages(content: string): ProtocolMessage[] {
  if (!content.includes(BODY_START)) {
    return [];
  }

  return content
    .split(new RegExp(`^${escapeRegExp(SPLIT_MESSAGE)}\\s*$`, "m"))
    .map((rawMessage) => parseProtocolMessage(rawMessage))
    .filter((message): message is ProtocolMessage => message !== null);
}

function parseProtocolMessage(rawMessage: string): ProtocolMessage | null {
  const serverProps = readDelimitedSection(
    rawMessage,
    SERVER_PROPS_START,
    SERVER_PROPS_END,
  );
  const clientProps = readDelimitedSection(
    rawMessage,
    CLIENT_PROPS_START,
    CLIENT_PROPS_END,
  );
  const body = readDelimitedSection(rawMessage, BODY_START, BODY_END);

  if (body === null) {
    return null;
  }

  const bodyLanguage = readClientType(clientProps) === "json" ? "json" : "html";
  const sections: ProtocolSection[] = [];

  if (serverProps !== null) {
    sections.push({
      title: "SERVER_PROPS",
      content: serverProps,
      language: "json",
    });
  }

  if (clientProps !== null) {
    sections.push({
      title: "CLIENT_PROPS",
      content: clientProps,
      language: "json",
    });
  }

  sections.push({
    title: "BODY",
    content: body,
    language: bodyLanguage,
  });

  return { sections };
}

function readDelimitedSection(
  text: string,
  startDelimiter: string,
  endDelimiter: string,
): string | null {
  const start = findDelimiterLine(text, startDelimiter);

  if (start === -1) {
    return null;
  }

  const contentStart = lineEndIndex(text, start + startDelimiter.length);
  const end = findDelimiterLine(text, endDelimiter, contentStart);

  if (end === -1) {
    return null;
  }

  return trimOneLeadingAndTrailingLineBreak(text.slice(contentStart, end));
}

function findDelimiterLine(
  text: string,
  delimiter: string,
  fromIndex = 0,
): number {
  let index = text.indexOf(delimiter, fromIndex);

  while (index !== -1) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + delimiter.length] || "";
    const startsLine = index === 0 || before === "\n" || before === "\r";
    const endsLine = after === "" || after === "\n" || after === "\r";

    if (startsLine && endsLine) {
      return index;
    }

    index = text.indexOf(delimiter, index + delimiter.length);
  }

  return -1;
}

function lineEndIndex(text: string, index: number): number {
  if (text[index] === "\r" && text[index + 1] === "\n") {
    return index + 2;
  }

  if (text[index] === "\n" || text[index] === "\r") {
    return index + 1;
  }

  return index;
}

function trimOneLeadingAndTrailingLineBreak(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function readClientType(clientProps: string | null): "html" | "json" {
  if (!clientProps) {
    return "html";
  }

  return /\btype\s*:\s*['"]json['"]/.test(clientProps) ||
    /"type"\s*:\s*"json"/.test(clientProps)
    ? "json"
    : "html";
}

function highlight(content: string, language: HighlightLanguage): string {
  if (language === "json") {
    return highlightJson(content);
  }

  if (language === "html") {
    return highlightHtml(content);
  }

  return escapeHtml(content);
}

function highlightJson(content: string): string {
  const tokenPattern =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g;
  let html = "";
  let lastIndex = 0;

  for (const match of content.matchAll(tokenPattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const stringValue = match[1];
    const colon = match[2];

    html += escapeHtml(content.slice(lastIndex, index));

    if (stringValue) {
      const escapedString = escapeHtml(stringValue);
      html += colon
        ? `<span class="key">${escapedString}</span>${escapeHtml(colon)}`
        : `<span class="string">${escapedString}</span>`;
    } else if (/^(true|false|null)$/.test(raw)) {
      html += `<span class="literal">${escapeHtml(raw)}</span>`;
    } else {
      html += `<span class="number">${escapeHtml(raw)}</span>`;
    }

    lastIndex = index + raw.length;
  }

  return html + escapeHtml(content.slice(lastIndex));
}

function highlightHtml(content: string): string {
  return escapeHtml(content).replace(
    /(&lt;\/?)([A-Za-z][\w:-]*)([^&]*?)(\/?&gt;)|(&lt;\?)([A-Za-z][\w:-]*)([^&]*?)(\?&gt;|&gt;)/g,
    (
      match,
      openTag: string | undefined,
      tagName: string | undefined,
      attrs: string | undefined,
      closeTag: string | undefined,
      openPi: string | undefined,
      piName: string | undefined,
      piAttrs: string | undefined,
      closePi: string | undefined,
    ) => {
      if (openPi && piName) {
        return `<span class="punct">${openPi}</span><span class="tag">${piName}</span>${highlightHtmlAttributes(piAttrs || "")}<span class="punct">${closePi || ""}</span>`;
      }

      if (!openTag || !tagName) {
        return match;
      }

      return `<span class="punct">${openTag}</span><span class="tag">${tagName}</span>${highlightHtmlAttributes(attrs || "")}<span class="punct">${closeTag || ""}</span>`;
    },
  );
}

function highlightHtmlAttributes(attrs: string): string {
  return attrs.replace(
    /([A-Za-z_:][\w:.-]*)(=)(&quot;(?:.*?)&quot;|'(?:.*?)')/g,
    '<span class="attr">$1</span><span class="punct">$2</span><span class="string">$3</span>',
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

const debugStyles = `
	:root {
		color-scheme: light dark;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
	}

	body {
		margin: 0;
		padding: 24px;
		background: light-dark(#f8fafc, #0f172a);
		color: light-dark(#0f172a, #e2e8f0);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 20px;
	}

	h1,
	h2,
	h3,
	h4,
	p {
		margin: 0;
	}

	p {
		color: light-dark(#475569, #94a3b8);
		font-size: 12px;
		margin-top: 6px;
	}

	h1 {
		font-size: 20px;
	}

	h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 15px;
		margin-bottom: 12px;
		text-transform: uppercase;
	}

	h2 span,
	h4 span {
		color: light-dark(#64748b, #94a3b8);
		font-size: 12px;
		font-weight: 500;
		text-transform: none;
	}

	h3 {
		font-size: 14px;
		margin-bottom: 10px;
	}

	h4 {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		margin-bottom: 6px;
	}

	.actions,
	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		justify-content: flex-end;
	}

	a,
	button {
		border: 1px solid light-dark(#cbd5e1, #475569);
		border-radius: 6px;
		background: light-dark(#ffffff, #1e293b);
		color: inherit;
		cursor: pointer;
		font: inherit;
		padding: 8px 10px;
		text-decoration: none;
	}

	a.active {
		background: light-dark(#0f172a, #e2e8f0);
		border-color: transparent;
		color: light-dark(#ffffff, #020617);
	}

	button {
		background: light-dark(#fee2e2, #7f1d1d);
		border-color: light-dark(#fecaca, #991b1b);
	}

	.raw,
	.code {
		white-space: pre-wrap;
		word-break: break-word;
		background: light-dark(#ffffff, #020617);
		border: 1px solid light-dark(#e2e8f0, #334155);
		border-radius: 8px;
		margin: 0;
		padding: 16px;
	}

	.messages {
		display: grid;
		gap: 16px;
	}

	.message,
	.protocol-message {
		border: 1px solid light-dark(#e2e8f0, #334155);
		border-radius: 8px;
		background: light-dark(#ffffff, #020617);
		padding: 14px;
	}

	.protocol-message {
		background: light-dark(#f8fafc, #0f172a);
		margin-top: 10px;
	}

	.block + .block {
		margin-top: 12px;
	}

	.code {
		background: light-dark(#ffffff, #020617);
	}

	.key {
		color: light-dark(#0369a1, #7dd3fc);
	}

	.string {
		color: light-dark(#047857, #86efac);
	}

	.number,
	.literal {
		color: light-dark(#b45309, #fbbf24);
	}

	.tag {
		color: light-dark(#7c3aed, #c4b5fd);
	}

	.attr {
		color: light-dark(#be123c, #fda4af);
	}

	.punct {
		color: light-dark(#64748b, #94a3b8);
	}

	@media (max-width: 760px) {
		body {
			padding: 16px;
		}

		header {
			display: grid;
		}

		.actions,
		nav {
			justify-content: flex-start;
		}
	}
`;
