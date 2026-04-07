import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, encryptToken, upsertIntegration } from "@agents/db";

const GH_TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const settingsUrl = new URL("/settings", url.origin);

  if (error) {
    settingsUrl.searchParams.set("gh", "error");
    settingsUrl.searchParams.set("reason", error);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state) {
    settingsUrl.searchParams.set("gh", "error");
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

  // Validate CSRF state from cookie. Use exact-name match (not startsWith)
  // so an attacker-set cookie like `gh_oauth_state_x=...` cannot be confused
  // for the real one.
  const cookieState = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === "gh_oauth_state")?.[1];

  if (!cookieState || cookieState !== state || cookieState.length !== 64) {
    settingsUrl.searchParams.set("gh", "error");
    settingsUrl.searchParams.set("reason", "state_mismatch");
    return NextResponse.redirect(settingsUrl);
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUrl = process.env.GITHUB_OAUTH_REDIRECT_URL;
  if (!clientId || !clientSecret || !redirectUrl) {
    settingsUrl.searchParams.set("gh", "error");
    settingsUrl.searchParams.set("reason", "not_configured");
    return NextResponse.redirect(settingsUrl);
  }

  // Exchange code for access token
  const tokenRes = await fetch(GH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUrl,
    }),
  });

  if (!tokenRes.ok) {
    settingsUrl.searchParams.set("gh", "error");
    settingsUrl.searchParams.set("reason", "token_exchange_failed");
    return NextResponse.redirect(settingsUrl);
  }

  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
  };

  if (!tokenBody.access_token) {
    settingsUrl.searchParams.set("gh", "error");
    settingsUrl.searchParams.set("reason", tokenBody.error ?? "no_token");
    return NextResponse.redirect(settingsUrl);
  }

  const scopes = (tokenBody.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const encrypted = encryptToken(tokenBody.access_token);

  const db = createServerClient();
  await upsertIntegration(db, user.id, "github", scopes, encrypted);

  // Auto-enable github tools so the agent can immediately use them.
  const githubToolIds = [
    "github_list_repos",
    "github_list_issues",
    "github_create_issue",
    "github_create_repo",
  ];
  for (const toolId of githubToolIds) {
    await db
      .from("user_tool_settings")
      .upsert(
        { user_id: user.id, tool_id: toolId, enabled: true, config_json: {} },
        { onConflict: "user_id,tool_id" }
      );
  }

  settingsUrl.searchParams.set("gh", "connected");
  const response = NextResponse.redirect(settingsUrl);
  // Clear the CSRF cookie.
  response.cookies.set("gh_oauth_state", "", { path: "/", maxAge: 0 });
  return response;
}
