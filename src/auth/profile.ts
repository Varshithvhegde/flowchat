import type { AppEnv } from "../env";

export type ProfileConsent = {
  privacyOk: boolean;
  necessaryCookieConsent: boolean;
};

export async function upsertUserProfile(
  env: AppEnv,
  user: { id: string; name: string; email: string },
  consent: ProfileConsent,
): Promise<void> {
  await env.AUTH_DB.prepare(
    `INSERT INTO user_profile (
      user_id,
      name,
      email,
      privacy_ok,
      necessary_cookie_consent,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      updated_at = excluded.updated_at`,
  )
    .bind(
      user.id,
      user.name,
      user.email,
      consent.privacyOk ? 1 : 0,
      consent.necessaryCookieConsent ? 1 : 0,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
}
