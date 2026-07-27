import { betterAuth } from "better-auth";
import type { AppEnv } from "../env";
import { sendVerificationEmail } from "./email";
import { upsertUserProfile } from "./profile";
import {
  isAuthProviderEnabled,
  shouldVerifyEmail,
} from "./providers";
import { assignInitialUserRole } from "./roles";

export type AuthProvider = "github" | "google";

export function createAuth(request: Request, env: AppEnv) {
  const origin = new URL(request.url).origin;
  const verifyEmail = shouldVerifyEmail(env);
  const socialProviders: {
    github?: {
      clientId: string;
      clientSecret: string;
      scope: string[];
    };
    google?: {
      clientId: string;
      clientSecret: string;
    };
  } = {};

  if (hasProviderCredentials(env, "github")) {
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID || "",
      clientSecret: env.GITHUB_CLIENT_SECRET || "",
      scope: ["user:email"],
    };
  }

  if (hasProviderCredentials(env, "google")) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID || "",
      clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    };
  }

  return betterAuth({
    appName: "PartialUpdate",
    baseURL: env.BETTER_AUTH_URL || origin,
    database: env.AUTH_DB,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", "google"],
      },
    },
    emailAndPassword: {
      enabled: isAuthProviderEnabled(env, "EMAIL_PASSWORD"),
      requireEmailVerification: verifyEmail,
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignIn: verifyEmail,
      sendOnSignUp: verifyEmail,
      async sendVerificationEmail(data) {
        if (!verifyEmail) {
          return;
        }

        await sendVerificationEmail(env, {
          email: data.user.email,
          name: data.user.name,
          url: data.url,
        });
      },
    },
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          async after(user) {
            await assignInitialUserRole(env, user.id);
            await upsertUserProfile(
              env,
              {
                email: user.email,
                id: user.id,
                name: user.name,
              },
              {
                necessaryCookieConsent: true,
                privacyOk: true,
              },
            );
          },
        },
        update: {
          async after(user) {
            await upsertUserProfile(
              env,
              {
                email: user.email,
                id: user.id,
                name: user.name,
              },
              {
                necessaryCookieConsent: true,
                privacyOk: true,
              },
            );
          },
        },
      },
    },
  });
}

export async function getAuthSession(request: Request, env: AppEnv) {
  return createAuth(request, env).api.getSession({
    headers: request.headers,
  });
}

export function hasProviderCredentials(
  env: AppEnv,
  provider: AuthProvider,
): boolean {
  if (provider === "github") {
    return Boolean(
      isAuthProviderEnabled(env, "GITHUB") &&
        env.GITHUB_CLIENT_ID &&
        env.GITHUB_CLIENT_SECRET,
    );
  }

  return Boolean(
    isAuthProviderEnabled(env, "GOOGLE") &&
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET,
  );
}
