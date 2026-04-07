import type { DbClient } from "../client";
import type { UserIntegration } from "@agents/types";

export async function getUserIntegrations(db: DbClient, userId: string) {
  const { data, error } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw error;
  return (data ?? []) as UserIntegration[];
}

export async function upsertIntegration(
  db: DbClient,
  userId: string,
  provider: string,
  scopes: string[],
  encryptedTokens: string
) {
  const { data, error } = await db
    .from("user_integrations")
    .upsert(
      {
        user_id: userId,
        provider,
        scopes,
        encrypted_tokens: encryptedTokens,
        status: "active",
      },
      { onConflict: "user_id,provider" }
    )
    .select()
    .single();
  if (error) throw error;
  return data as UserIntegration;
}

export async function revokeIntegration(
  db: DbClient,
  userId: string,
  provider: string
) {
  const { error } = await db
    .from("user_integrations")
    .update({ status: "revoked" })
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw error;
}

/**
 * Returns the active integration for a given provider, including the encrypted token.
 * Used server-side only — the encrypted token must be decrypted with `decryptToken`.
 */
export async function getIntegrationByProvider(
  db: DbClient,
  userId: string,
  provider: string
): Promise<(UserIntegration & { encrypted_tokens: string }) | null> {
  const { data, error } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as (UserIntegration & { encrypted_tokens: string }) | null) ?? null;
}
