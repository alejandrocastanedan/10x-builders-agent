import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const SCOPES = "repo read:user";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUrl = process.env.GITHUB_OAUTH_REDIRECT_URL;
  if (!clientId || !redirectUrl) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured (missing GITHUB_CLIENT_ID or GITHUB_OAUTH_REDIRECT_URL)" },
      { status: 500 }
    );
  }

  const state = randomBytes(32).toString("hex");

  const authorizeUrl = new URL(GH_AUTHORIZE);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("allow_signup", "false");

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set("gh_oauth_state", state, {
    httpOnly: true,
    // Only require Secure on HTTPS — on http://localhost the browser drops Secure cookies.
    secure: redirectUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes
  });
  return response;
}
