import type { AppEnv } from "../env";

export async function sendVerificationEmail(
  env: AppEnv,
  options: {
    email: string;
    name: string;
    url: string;
  },
): Promise<void> {
  if (!env.EMAIL) {
    throw new Error("VERIFY_EMAIL is enabled but EMAIL binding is not configured");
  }

  const fromEmail = env.EMAIL_FROM || "noreply@partialupdate.com";
  const fromName = env.EMAIL_FROM_NAME || "PartialUpdate";

  await env.EMAIL.send({
    from: { email: fromEmail, name: fromName },
    html: renderVerificationHtml(options.name, options.url),
    subject: "Verify your PartialUpdate email",
    text: renderVerificationText(options.name, options.url),
    to: options.email,
  });
}

function renderVerificationText(name: string, url: string): string {
  return `Hi ${name || "there"},

Verify your PartialUpdate email address:

${url}

If you did not request this, you can ignore this email.`;
}

function renderVerificationHtml(name: string, url: string): string {
  const safeName = escapeHtml(name || "there");
  const safeUrl = escapeHtml(url);

  return `<p>Hi ${safeName},</p>
<p>Verify your PartialUpdate email address:</p>
<p><a href="${safeUrl}">Verify email address</a></p>
<p>If you did not request this, you can ignore this email.</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
