import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";

const NOTION_AUTHORIZE = "https://api.notion.com/v1/oauth/authorize";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"));
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  const redirectUrl = process.env.NOTION_OAUTH_REDIRECT_URL;
  if (!clientId || !redirectUrl) {
    return NextResponse.json(
      { error: "Notion OAuth is not configured (missing NOTION_CLIENT_ID or NOTION_OAUTH_REDIRECT_URL)" },
      { status: 500 }
    );
  }

  const state = randomBytes(32).toString("hex");

  // Notion does NOT use a `scope` param — capabilities are configured at the
  // integration level in the Notion dashboard. `owner=user` is required for
  // public integrations.
  const authorizeUrl = new URL(NOTION_AUTHORIZE);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("owner", "user");
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl.toString());
  response.cookies.set("notion_oauth_state", state, {
    httpOnly: true,
    // Only require Secure on HTTPS — on http://localhost the browser drops Secure cookies.
    secure: redirectUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes
  });
  return response;
}
