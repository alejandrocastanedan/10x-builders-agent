import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, encryptToken, upsertIntegration } from "@agents/db";

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const settingsUrl = new URL("/settings", url.origin);

  if (error) {
    settingsUrl.searchParams.set("notion", "error");
    settingsUrl.searchParams.set("reason", error);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state) {
    settingsUrl.searchParams.set("notion", "error");
    settingsUrl.searchParams.set("reason", "missing_params");
    return NextResponse.redirect(settingsUrl);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  // Validate CSRF state from cookie. Use Next's parsed cookie jar (exact name
  // match) instead of manual prefix splitting, which would also accept e.g.
  // `notion_oauth_state_x=...` set by an attacker.
  const cookieState = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === "notion_oauth_state")?.[1];

  if (!cookieState || cookieState !== state || cookieState.length !== 64) {
    settingsUrl.searchParams.set("notion", "error");
    settingsUrl.searchParams.set("reason", "state_mismatch");
    return NextResponse.redirect(settingsUrl);
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  const redirectUrl = process.env.NOTION_OAUTH_REDIRECT_URL;
  if (!clientId || !clientSecret || !redirectUrl) {
    settingsUrl.searchParams.set("notion", "error");
    settingsUrl.searchParams.set("reason", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  // Notion requires HTTP Basic auth with client_id:client_secret in the
  // Authorization header (unlike GitHub which accepts them in the body).
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const tokenRes = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUrl,
    }),
  });

  if (!tokenRes.ok) {
    settingsUrl.searchParams.set("notion", "error");
    settingsUrl.searchParams.set("reason", "token_exchange_failed");
    return NextResponse.redirect(settingsUrl);
  }

  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    workspace_id?: string;
    workspace_name?: string;
    bot_id?: string;
    error?: string;
  };

  if (!tokenBody.access_token) {
    settingsUrl.searchParams.set("notion", "error");
    settingsUrl.searchParams.set("reason", tokenBody.error ?? "no_token");
    return NextResponse.redirect(settingsUrl);
  }

  // Notion has no runtime scopes; record the workspace identifiers as
  // pseudo-scopes so the operator can see which workspace was authorized.
  const scopes = [
    tokenBody.workspace_name ? `workspace:${tokenBody.workspace_name}` : null,
    tokenBody.workspace_id ? `workspace_id:${tokenBody.workspace_id}` : null,
  ].filter((s): s is string => Boolean(s));

  const encrypted = encryptToken(tokenBody.access_token);

  const db = createServerClient();
  await upsertIntegration(db, user.id, "notion", scopes, encrypted);

  // Auto-enable notion tools so the agent can immediately use them.
  const notionToolIds = [
    "notion_search",
    "notion_retrieve_page",
    "notion_query_database",
    "notion_create_page",
    "notion_append_paragraph",
  ];
  for (const toolId of notionToolIds) {
    await db
      .from("user_tool_settings")
      .upsert(
        { user_id: user.id, tool_id: toolId, enabled: true, config_json: {} },
        { onConflict: "user_id,tool_id" }
      );
  }

  settingsUrl.searchParams.set("notion", "connected");
  const response = NextResponse.redirect(settingsUrl);
  // Clear the CSRF cookie.
  response.cookies.set("notion_oauth_state", "", { path: "/", maxAge: 0 });
  return response;
}
