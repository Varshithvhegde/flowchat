import type { AppEnv } from "../env";
import { isAuthEnabled, shouldVerifyEmail } from "./providers";

export const USER_ROLES = ["admin", "dev", "chat", "view", "blocked"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export type RolePermission =
  | "admin"
  | "chat"
  | "debug"
  | "viewFork"
  | "websocket";

export type UserWithRole = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: UserRole;
  createdAt: string;
};

export type RoleGateResult =
  | { ok: true; role: UserRole | "anonymous" | "disabled"; userId?: string }
  | { ok: false; response: Response };

type AuthSession = {
  user: {
    emailVerified: boolean;
    id: string;
    email?: string;
  };
} | null;

const rolePermissions: Record<UserRole, Set<RolePermission>> = {
  admin: new Set(["admin", "chat", "debug", "viewFork", "websocket"]),
  dev: new Set(["chat", "debug", "viewFork", "websocket"]),
  chat: new Set(["chat", "viewFork", "websocket"]),
  view: new Set(["viewFork"]),
  blocked: new Set(),
};

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

export async function assignInitialUserRole(
  env: AppEnv,
  userId: string,
): Promise<void> {
  const row = await env.AUTH_DB.prepare(
    "SELECT COUNT(*) AS count FROM user WHERE id != ?",
  )
    .bind(userId)
    .first<{ count: number }>();
  const role: UserRole = row?.count === 0 ? "admin" : "view";
  await setUserRole(env, userId, role);
}

export async function getUserRole(
  env: AppEnv,
  userId: string,
): Promise<UserRole> {
  const row = await env.AUTH_DB.prepare("SELECT role FROM user WHERE id = ?")
    .bind(userId)
    .first<{ role: string | null }>();
  const role = row?.role || "view";
  return isUserRole(role) ? role : "view";
}

export async function setUserRole(
  env: AppEnv,
  userId: string,
  role: UserRole,
): Promise<void> {
  await env.AUTH_DB.prepare("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?")
    .bind(role, new Date().toISOString(), userId)
    .run();
}

export async function listUsersWithRoles(env: AppEnv): Promise<UserWithRole[]> {
  const result = await env.AUTH_DB.prepare(
    `SELECT id, name, email, emailVerified, role, createdAt
      FROM user
      ORDER BY createdAt ASC`,
  ).all<{
    id: string;
    name: string;
    email: string;
    emailVerified: number;
    role: string | null;
    createdAt: string;
  }>();

  return (result.results || []).map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    role: user.role && isUserRole(user.role) ? user.role : "view",
    createdAt: user.createdAt,
  }));
}

export async function requireRolePermission(
  request: Request,
  env: AppEnv,
  session: AuthSession,
  permission: RolePermission,
): Promise<RoleGateResult> {
  if (!isAuthEnabled(env)) {
    return { ok: true, role: "disabled" };
  }

  const url = new URL(request.url);

  if (!session) {
    if (permission === "viewFork") {
      return { ok: true, role: "anonymous" };
    }

    return {
      ok: false,
      response: Response.redirect(authRedirectUrl(url, "/sign-up"), 302),
    };
  }

  if (shouldVerifyEmail(env) && !session.user.emailVerified) {
    return {
      ok: false,
      response: Response.redirect(authRedirectUrl(url, "/sign-in"), 302),
    };
  }

  const role = await getUserRole(env, session.user.id);

  if (!rolePermissions[role].has(permission)) {
    return {
      ok: false,
      response: new Response("Forbidden", {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        },
        status: 403,
      }),
    };
  }

  return { ok: true, role, userId: session.user.id };
}

function authRedirectUrl(source: URL, pathname: "/sign-in" | "/sign-up"): string {
  const redirect = new URL(pathname, source.origin);
  redirect.searchParams.set("next", source.pathname + source.search);
  return redirect.toString();
}
