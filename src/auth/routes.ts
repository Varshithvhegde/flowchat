import type { AppEnv } from "../env";
import {
  createAuth,
  getAuthSession,
  hasProviderCredentials,
  type AuthProvider,
} from "./server";
import {
  getEnabledAuthProviderList,
  isAuthEnabled,
  isAuthProviderEnabled,
  shouldVerifyEmail,
} from "./providers";
import {
  listUsersWithRoles,
  requireRolePermission,
  setUserRole,
  USER_ROLES,
  isUserRole,
  type UserRole,
  type UserWithRole,
} from "./roles";

const authHtmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
};

export function isAuthRoute(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname === "/sign-out" ||
    pathname === "/sign-up" ||
    pathname === "/admin" ||
    pathname === "/private-hello" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/auth/resend-verification" ||
    pathname === "/auth/sign-out" ||
    pathname.startsWith("/auth/sign-in/") ||
    pathname.startsWith("/auth/sign-up/")
  );
}

export async function handleAuthRoute(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const authEnabled = isAuthEnabled(env);

  if (!authEnabled) {
    if (request.method === "GET" && url.pathname === "/private-hello") {
      return new Response("hello world", {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/sign-in" || url.pathname === "/sign-up")
    ) {
      return Response.redirect(new URL("/", url.origin).toString(), 302);
    }

    return new Response("Authentication is not enabled", { status: 404 });
  }

  if (!env.BETTER_AUTH_SECRET) {
    return new Response("Authentication is not configured", { status: 503 });
  }

  if (url.pathname.startsWith("/api/auth/")) {
    if (
      request.method === "POST" &&
      (url.pathname === "/api/auth/sign-in/social" ||
        url.pathname === "/api/auth/sign-up/email")
    ) {
      return new Response("Use /sign-up to start sign up.", {
        status: 403,
      });
    }

    return createAuth(request, env).handler(request);
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/sign-in" || url.pathname === "/sign-up")
  ) {
    const session = await getAuthSession(request, env);
    const nextPath = nextPathFromUrl(url);

    if (session?.user.emailVerified) {
      return Response.redirect(new URL(nextPath, url.origin).toString(), 302);
    }

    if (session && shouldVerifyEmail(env)) {
      return new Response(
        renderCheckEmailPage(session.user.email, {
          canResend: true,
          resendEmail: session.user.email,
        }),
        { headers: authHtmlHeaders },
      );
    }

    return new Response(
      renderAuthPage(env, authModeFromPath(url.pathname), {
        nextPath,
      }),
      {
        headers: authHtmlHeaders,
      },
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/auth/resend-verification"
  ) {
    return resendVerificationEmail(request, env);
  }

  if (request.method === "POST" && url.pathname === "/auth/sign-out") {
    return signOut(request, env, { redirect: false });
  }

  if (request.method === "GET" && url.pathname === "/admin") {
    return renderAdminRoute(request, env);
  }

  if (request.method === "POST" && url.pathname === "/admin") {
    return updateUserRoleRoute(request, env);
  }

  if (request.method === "GET" && url.pathname === "/sign-out") {
    return signOut(request, env, { redirect: true });
  }

  if (request.method === "POST" && url.pathname === "/auth/sign-in/email") {
    return startEmailPasswordSignIn(request, env);
  }

  if (request.method === "POST" && url.pathname.startsWith("/auth/sign-in/")) {
    const provider = parseProvider(url.pathname);

    if (!provider) {
      return new Response("Unknown auth provider", { status: 404 });
    }

    return startSocialSignIn(request, env, provider);
  }

  if (request.method === "POST" && url.pathname === "/auth/sign-up/email") {
    return startEmailPasswordSignUp(request, env);
  }

  if (request.method === "GET" && url.pathname === "/private-hello") {
    const session = await getAuthSession(request, env);

    if (!session) {
      return Response.redirect(authPageUrl(url, "/sign-up"), 302);
    }

    if (shouldVerifyEmail(env) && !session.user.emailVerified) {
      return new Response(
        renderCheckEmailPage(session.user.email, {
          canResend: true,
          resendEmail: session.user.email,
        }),
        { headers: authHtmlHeaders },
      );
    }

    return new Response("hello world", {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

async function signOut(
  request: Request,
  env: AppEnv,
  options: { redirect: boolean },
): Promise<Response> {
  const url = new URL(request.url);
  const authRequest = new Request(
    new URL("/api/auth/sign-out", url.origin).toString(),
    {
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("Cookie") || "",
        Origin: url.origin,
      },
      method: "POST",
    },
  );
  const authResponse = await createAuth(request, env).handler(authRequest);
  const response = options.redirect
    ? new Response(null, {
        headers: {
          Location: new URL("/sign-in", url.origin).toString(),
        },
        status: 303,
      })
    : new Response(null, {
        status: authResponse.ok ? 204 : authResponse.status,
      });
  appendSetCookieHeaders(response.headers, authResponse.headers);
  return response;
}

async function resendVerificationEmail(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  if (!shouldVerifyEmail(env)) {
    return Response.redirect(
      new URL("/private-hello", request.url).toString(),
      303,
    );
  }

  const session = await getAuthSession(request, env);
  const form = await request.formData();
  const submittedEmail = getRequiredFormString(form, "email");
  const email = session?.user.email || submittedEmail;

  if (!email) {
    return Response.redirect(new URL("/sign-up", request.url).toString(), 303);
  }

  if (session?.user.emailVerified) {
    return Response.redirect(
      new URL("/private-hello", request.url).toString(),
      303,
    );
  }

  const url = new URL(request.url);
  const authRequest = new Request(
    new URL("/api/auth/send-verification-email", url.origin).toString(),
    {
      body: JSON.stringify({
        callbackURL: "/private-hello",
        email,
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("Cookie") || "",
        Origin: url.origin,
      },
      method: "POST",
    },
  );
  const authResponse = await createAuth(request, env).handler(authRequest);

  if (!authResponse.ok) {
    const data = await readAuthResponseJson(authResponse);

    return new Response(
      renderCheckEmailPage(email, {
        canResend: true,
        resendEmail: email,
        error: data.message || "Unable to resend verification email.",
      }),
      {
        headers: authHtmlHeaders,
        status: authResponse.status,
      },
    );
  }

  return new Response(
    renderCheckEmailPage(email, {
      canResend: true,
      resendEmail: email,
      resent: true,
    }),
    { headers: authHtmlHeaders },
  );
}

async function renderAdminRoute(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getAuthSession(request, env);
  const gate = await requireRolePermission(request, env, session, "admin");

  if (!gate.ok) {
    return gate.response;
  }

  return new Response(renderAdminPage(await listUsersWithRoles(env)), {
    headers: authHtmlHeaders,
  });
}

async function updateUserRoleRoute(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const session = await getAuthSession(request, env);
  const gate = await requireRolePermission(request, env, session, "admin");

  if (!gate.ok) {
    return gate.response;
  }

  const form = await request.formData();
  const userId = getRequiredFormString(form, "userId");
  const role = getRequiredFormString(form, "role");

  if (!userId || !isUserRole(role)) {
    return new Response(
      renderAdminPage(await listUsersWithRoles(env), "Invalid role update."),
      {
        headers: authHtmlHeaders,
        status: 400,
      },
    );
  }

  await setUserRole(env, userId, role);
  return Response.redirect(new URL("/admin", request.url).toString(), 303);
}

async function readAuthResponseJson(
  response: Response,
): Promise<{ code?: string; message?: string }> {
  try {
    return (await response.json()) as { code?: string; message?: string };
  } catch {
    return {};
  }
}

type AuthMode = "sign-in" | "sign-up";

function nextPathFromUrl(url: URL): string {
  return normalizeNextPath(url.searchParams.get("next"));
}

function nextPathFromForm(form: FormData): string {
  return normalizeNextPath(getRequiredFormString(form, "next"));
}

function normalizeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/private-hello";
  }

  return value.startsWith("/auth/") ||
    value === "/sign-in" ||
    value === "/sign-up" ||
    value === "/sign-out"
    ? "/private-hello"
    : value;
}

function urlWithNext(pathname: string, nextPath: string): string {
  const params = new URLSearchParams();

  if (nextPath !== "/private-hello") {
    params.set("next", nextPath);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function authPageUrl(source: URL, pathname: "/sign-in" | "/sign-up"): string {
  const nextPath = normalizeNextPath(source.pathname + source.search);
  return new URL(urlWithNext(pathname, nextPath), source.origin).toString();
}

function authModeFromPath(pathname: string): AuthMode {
  return pathname === "/sign-in" ? "sign-in" : "sign-up";
}

function getAuthModeFromForm(form: FormData): AuthMode {
  return form.get("mode") === "sign-in" ? "sign-in" : "sign-up";
}

async function startEmailPasswordSignUp(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  if (!isAuthProviderEnabled(env, "EMAIL_PASSWORD")) {
    return new Response("Email and password sign up is not enabled", {
      status: 404,
    });
  }

  const form = await request.formData();
  const name = getRequiredFormString(form, "name");
  const email = getRequiredFormString(form, "email");
  const password = getRequiredFormString(form, "password");
  const privacyOk = form.get("privacyOk") === "on";
  const necessaryCookieConsent = form.get("necessaryCookieConsent") === "on";
  const nextPath = nextPathFromForm(form);

  if (!name || !email || !password || !privacyOk || !necessaryCookieConsent) {
    return new Response(
      renderAuthPage(env, "sign-up", {
        error: "Please complete all required fields.",
        nextPath,
        showEmailForm: true,
      }),
      {
        headers: authHtmlHeaders,
        status: 400,
      },
    );
  }

  const url = new URL(request.url);
  const authRequest = new Request(
    new URL("/api/auth/sign-up/email", url.origin).toString(),
    {
      body: JSON.stringify({
        callbackURL: nextPath,
        email,
        name,
        password,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
      },
      method: "POST",
    },
  );
  const authResponse = await createAuth(request, env).handler(authRequest);
  const data = (await authResponse.json()) as {
    code?: string;
    message?: string;
    token?: string | null;
  };

  if (!authResponse.ok) {
    return new Response(
      renderAuthPage(env, "sign-up", {
        error: data.message || "Unable to create account.",
        nextPath,
        showEmailForm: true,
      }),
      {
        headers: authHtmlHeaders,
        status: authResponse.status,
      },
    );
  }

  if (shouldVerifyEmail(env)) {
    return new Response(
      renderCheckEmailPage(email, { canResend: true, resendEmail: email }),
      {
        headers: authHtmlHeaders,
      },
    );
  }

  const response = new Response(null, {
    headers: {
      Location: new URL(nextPath, url.origin).toString(),
    },
    status: 303,
  });
  appendSetCookieHeaders(response.headers, authResponse.headers);
  return response;
}

async function startEmailPasswordSignIn(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  if (!isAuthProviderEnabled(env, "EMAIL_PASSWORD")) {
    return new Response("Email and password sign in is not enabled", {
      status: 404,
    });
  }

  const form = await request.formData();
  const email = getRequiredFormString(form, "email");
  const password = getRequiredFormString(form, "password");
  const nextPath = nextPathFromForm(form);

  if (!email || !password) {
    return new Response(
      renderAuthPage(env, "sign-in", {
        error: "Please complete all required fields.",
        nextPath,
      }),
      {
        headers: authHtmlHeaders,
        status: 400,
      },
    );
  }

  const url = new URL(request.url);
  const authRequest = new Request(
    new URL("/api/auth/sign-in/email", url.origin).toString(),
    {
      body: JSON.stringify({
        callbackURL: nextPath,
        email,
        password,
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
      },
      method: "POST",
    },
  );
  const authResponse = await createAuth(request, env).handler(authRequest);
  const data = await readAuthResponseJson(authResponse);

  if (!authResponse.ok) {
    if (data.code === "EMAIL_NOT_VERIFIED") {
      return new Response(
        renderCheckEmailPage(email, {
          canResend: true,
          resendEmail: email,
        }),
        { headers: authHtmlHeaders },
      );
    }

    return new Response(
      renderAuthPage(env, "sign-in", {
        error: data.message || "Unable to sign in.",
        nextPath,
      }),
      {
        headers: authHtmlHeaders,
        status: authResponse.status,
      },
    );
  }

  const response = new Response(null, {
    headers: {
      Location: new URL(nextPath, url.origin).toString(),
    },
    status: 303,
  });
  appendSetCookieHeaders(response.headers, authResponse.headers);
  return response;
}

async function startSocialSignIn(
  request: Request,
  env: AppEnv,
  provider: AuthProvider,
): Promise<Response> {
  const form = await request.formData();
  const mode = getAuthModeFromForm(form);
  const privacyOk = form.get("privacyOk") === "on";
  const necessaryCookieConsent = form.get("necessaryCookieConsent") === "on";
  const nextPath = nextPathFromForm(form);

  if (mode === "sign-up" && (!privacyOk || !necessaryCookieConsent)) {
    return new Response(
      renderAuthPage(env, mode, {
        error: "Please confirm both consent options.",
        nextPath,
      }),
      {
        headers: authHtmlHeaders,
        status: 400,
      },
    );
  }

  if (!hasProviderCredentials(env, provider)) {
    return new Response(
      renderAuthPage(env, mode, {
        error: `The ${provider} provider is not configured yet.`,
        nextPath,
      }),
      {
        headers: authHtmlHeaders,
        status: 503,
      },
    );
  }

  const url = new URL(request.url);
  const authRequest = new Request(
    new URL("/api/auth/sign-in/social", url.origin).toString(),
    {
      body: JSON.stringify({
        callbackURL: nextPath,
        errorCallbackURL: urlWithNext("/sign-up", nextPath),
        newUserCallbackURL: nextPath,
        provider,
        requestSignUp: mode === "sign-up",
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  const authResponse = await createAuth(request, env).handler(authRequest);
  const data = (await authResponse.json()) as {
    redirect?: boolean;
    url?: string;
  };

  if (!data.url) {
    return new Response("Unable to start sign in", { status: 500 });
  }

  const response = new Response(null, {
    headers: {
      Location: data.url,
    },
    status: 303,
  });
  appendSetCookieHeaders(response.headers, authResponse.headers);
  return response;
}

function getRequiredFormString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parseProvider(pathname: string): AuthProvider | null {
  const provider = pathname.split("/").filter(Boolean).at(-1);
  return provider === "github" || provider === "google" ? provider : null;
}

function appendSetCookieHeaders(target: Headers, source: Headers): void {
  const withGetSetCookie = source as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = withGetSetCookie.getSetCookie?.();

  if (cookies?.length) {
    for (const cookie of cookies) {
      target.append("Set-Cookie", cookie);
    }
    return;
  }

  const cookie = source.get("Set-Cookie");

  if (cookie) {
    target.append("Set-Cookie", cookie);
  }
}

function renderAdminPage(users: UserWithRole[], error = ""): string {
  const rows = users
    .map(
      (user) => `<tr>
        <td>
          <strong>${escapeHtml(user.name || user.email)}</strong>
          <span>${escapeHtml(user.email)}</span>
        </td>
        <td>${user.emailVerified ? "verified" : "unverified"}</td>
        <td>${escapeHtml(user.createdAt)}</td>
        <td>
          <form method="post" action="/admin">
            <input type="hidden" name="userId" value="${escapeHtml(user.id)}" />
            <select name="role">${renderRoleOptions(user.role)}</select>
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin - FlowChat</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        background: Canvas;
        color: CanvasText;
        margin: 0;
        padding: 24px;
      }

      main {
        margin: 0 auto;
        max-width: 960px;
      }

      h1 {
        font-size: 2rem;
        margin: 0 0 20px;
      }

      table {
        border-collapse: collapse;
        width: 100%;
      }

      th,
      td {
        border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        padding: 12px;
        text-align: left;
        vertical-align: middle;
      }

      td strong,
      td span {
        display: block;
      }

      td span {
        color: color-mix(in srgb, CanvasText 68%, transparent);
        font-size: 0.9rem;
        margin-top: 3px;
      }

      form {
        display: flex;
        gap: 8px;
      }

      button,
      select {
        border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
        border-radius: 6px;
        font: inherit;
        min-height: 40px;
        padding: 0 10px;
      }

      button {
        cursor: pointer;
      }

      .error {
        color: #b42318;
        font-weight: 700;
      }

      @media (max-width: 720px) {
        table,
        tbody,
        tr,
        td {
          display: block;
        }

        thead {
          display: none;
        }

        tr {
          border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
          padding: 12px 0;
        }

        td {
          border: 0;
          padding: 6px 0;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Admin</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Created</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function renderRoleOptions(selected: UserRole): string {
  return USER_ROLES.map(
    (role) =>
      `<option value="${role}" ${role === selected ? "selected" : ""}>${role}</option>`,
  ).join("");
}

function renderSocialProviderButton(options: {
  action: string;
  enabled: boolean;
  isSignIn: boolean;
  label: string;
}): string {
  return `<button type="submit" formaction="${options.action}" formnovalidate ${options.enabled ? "" : "disabled"}>${options.isSignIn ? "Sign in" : "Sign up"} with ${options.label}</button>`;
}

function renderConsentFields(): string {
  return `<label>
    <input type="checkbox" name="privacyOk" required />
    <span>I agree to the privacy terms for storing my name and email.</span>
  </label>
  <label>
    <input type="checkbox" name="necessaryCookieConsent" required />
    <span>I consent to necessary authentication cookies.</span>
  </label>`;
}

function renderAuthPage(
  env: AppEnv,
  mode: AuthMode,
  options: {
    error?: string;
    nextPath?: string;
    showEmailForm?: boolean;
  } = {},
): string {
  const providers = getEnabledAuthProviderList(env);
  const emailOnly = providers.length === 1 && providers[0] === "EMAIL_PASSWORD";
  const error = options.error || "";
  const nextPath = normalizeNextPath(options.nextPath || "");
  const emailFormVisible =
    mode === "sign-up" && (options.showEmailForm || emailOnly);
  const githubEnabled = hasProviderCredentials(env, "github");
  const googleEnabled = hasProviderCredentials(env, "google");
  const isSignIn = mode === "sign-in";
  const providerControls = providers
    .map((provider) => {
      if (provider === "EMAIL_PASSWORD") {
        if (isSignIn) {
          return `<div class="fields">
            <label class="field-label">
              <span>Email</span>
              <input type="email" name="email" autocomplete="email" required />
            </label>
            <label class="field-label">
              <span>Password</span>
              <input type="password" name="password" autocomplete="current-password" required />
            </label>
            <button type="submit" formaction="/auth/sign-in/email">Sign in with email</button>
          </div>
          `;
        }

        return `<div class="email-sign-up">
          <button type="button" id="email-sign-up-toggle" aria-controls="email-fields" aria-expanded="${emailFormVisible ? "true" : "false"}" ${emailFormVisible ? "hidden" : ""}>Sign up with email</button>
          <div class="fields" id="email-fields" ${emailFormVisible ? "" : "hidden"}>
            <label class="field-label">
              <span>Name</span>
              <input type="text" name="name" autocomplete="name" ${emailFormVisible ? "required" : "disabled"} />
            </label>
            <label class="field-label">
              <span>Email</span>
              <input type="email" name="email" autocomplete="email" ${emailFormVisible ? "required" : "disabled"} />
            </label>
            <label class="field-label">
              <span>Password</span>
              <input type="password" name="password" autocomplete="new-password" minlength="8" ${emailFormVisible ? "required" : "disabled"} />
            </label>
            <button type="submit" formaction="/auth/sign-up/email">Create account</button>
          </div>
        </div>`;
      }

      if (provider === "GITHUB") {
        return renderSocialProviderButton({
          action: "/auth/sign-in/github",
          enabled: githubEnabled,
          isSignIn,
          label: "GitHub",
        });
      }

      return renderSocialProviderButton({
        action: "/auth/sign-in/google",
        enabled: googleEnabled,
        isSignIn,
        label: "Google",
      });
    })
    .join("");
  const title = isSignIn ? "Sign in" : "Sign up";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title} - FlowChat</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        align-items: center;
        background: Canvas;
        color: CanvasText;
        display: flex;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }

      main {
        margin: 0 auto;
        max-width: 420px;
        width: 100%;
      }

      h1 {
        font-size: 2rem;
        line-height: 1.1;
        margin: 0 0 12px;
      }

      p {
        line-height: 1.5;
        margin: 0 0 20px;
      }

      form {
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 8px;
        display: grid;
        gap: 16px;
        padding: 20px;
      }

      label {
        display: flex;
        gap: 10px;
        line-height: 1.4;
      }

      button {
        border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        min-height: 44px;
        padding: 0 14px;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      [hidden] {
        display: none !important;
      }

      input[type="email"],
      input[type="password"],
      input[type="text"] {
        border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
        border-radius: 6px;
        box-sizing: border-box;
        font: inherit;
        min-height: 44px;
        padding: 0 12px;
        width: 100%;
      }

      .actions {
        display: grid;
        gap: 10px;
      }

      .error {
        color: #b42318;
        font-weight: 600;
      }

      .fields {
        display: grid;
        gap: 10px;
      }

      .field-label {
        display: grid;
        gap: 6px;
      }

      .email-sign-up {
        display: grid;
        gap: 10px;
      }

      .tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        margin: 0 0 16px;
      }

      .tab {
        border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
        color: inherit;
        padding: 10px 12px;
        text-align: center;
        text-decoration: none;
      }

      .tab:first-child {
        border-radius: 6px 0 0 6px;
      }

      .tab:last-child {
        border-left: 0;
        border-radius: 0 6px 6px 0;
      }

      .tab[aria-current="page"] {
        background: color-mix(in srgb, CanvasText 8%, transparent);
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${isSignIn ? "Sign in to your FlowChat account." : "Create a FlowChat account."}</p>
      <nav class="tabs" aria-label="Authentication">
        <a class="tab" href="${escapeHtml(urlWithNext("/sign-in", nextPath))}" ${isSignIn ? `aria-current="page"` : ""}>Sign in</a>
        <a class="tab" href="${escapeHtml(urlWithNext("/sign-up", nextPath))}" ${isSignIn ? "" : `aria-current="page"`}>Sign up</a>
      </nav>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="post">
        <input type="hidden" name="mode" value="${mode}" />
        <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
        ${isSignIn ? "" : renderConsentFields()}
        <div class="actions">
          ${providerControls}
        </div>
      </form>
      <script>
        const toggle = document.getElementById("email-sign-up-toggle");
        const fields = document.getElementById("email-fields");

        toggle?.addEventListener("click", () => {
          fields.hidden = false;
          toggle.setAttribute("aria-expanded", "true");
          toggle.hidden = true;

          for (const input of fields.querySelectorAll("input:disabled")) {
            input.disabled = false;
            input.required = true;
          }

          fields.querySelector("input")?.focus();
        });
      </script>
    </main>
  </body>
</html>`;
}

function renderCheckEmailPage(
  email: string,
  options: {
    canResend?: boolean;
    error?: string;
    resendEmail?: string;
    resent?: boolean;
  } = {},
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Check your email - FlowChat</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        align-items: center;
        background: Canvas;
        color: CanvasText;
        display: flex;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }

      main {
        margin: 0 auto;
        max-width: 420px;
        width: 100%;
      }

      h1 {
        font-size: 2rem;
        line-height: 1.1;
        margin: 0 0 12px;
      }

      p {
        line-height: 1.5;
      }

      form {
        margin: 24px 0 0;
      }

      button {
        border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        min-height: 44px;
        padding: 0 14px;
        width: 100%;
      }

      .error {
        color: #b42318;
        font-weight: 600;
      }

      .success {
        color: #067647;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Check your email</h1>
      <p>We sent a verification link to ${escapeHtml(email)}.</p>
      ${
        options.resent
          ? `<p class="success">Verification email resent.</p>`
          : ""
      }
      ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
      ${
        options.canResend
          ? `<form method="post" action="/auth/resend-verification">
        ${options.resendEmail ? `<input type="hidden" name="email" value="${escapeHtml(options.resendEmail)}" />` : ""}
        <button type="submit">Resend verification email</button>
      </form>`
          : ""
      }
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
