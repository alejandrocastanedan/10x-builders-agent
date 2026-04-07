import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptToken,
  getIntegrationByProvider,
  getPendingToolCall,
  updateToolCallStatus,
} from "@agents/db";
import { executeTool } from "@agents/agent";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = (await request.json()) as {
      toolCallId?: string;
      action?: "approve" | "reject";
    };

    if (!toolCallId || (action !== "approve" && action !== "reject")) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const db = createServerClient();
    const toolCall = await getPendingToolCall(db, toolCallId);
    if (!toolCall) {
      return NextResponse.json(
        { error: "Tool call not found or no longer pending" },
        { status: 404 }
      );
    }

    // Verify the tool call belongs to a session of this user.
    const { data: session } = await db
      .from("agent_sessions")
      .select("user_id")
      .eq("id", toolCall.session_id)
      .single();
    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (action === "reject") {
      await updateToolCallStatus(db, toolCallId, "rejected");
      return NextResponse.json({ ok: true, result: null });
    }

    // approve → load tokens and execute the real tool.
    const ghIntegration = await getIntegrationByProvider(db, user.id, "github");
    const integrationTokens: { github?: string } = {};
    if (ghIntegration?.encrypted_tokens) {
      integrationTokens.github = decryptToken(ghIntegration.encrypted_tokens);
    }

    const { data: toolSettings } = await db
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const result = await executeTool(toolCall.tool_name, toolCall.arguments_json, {
      db,
      userId: user.id,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrationTokens,
    });

    if (result.ok) {
      await updateToolCallStatus(db, toolCallId, "executed", result.data);
    } else {
      await updateToolCallStatus(db, toolCallId, "failed", { error: result.error });
    }

    return NextResponse.json({ ok: result.ok, result: result.data ?? null, error: result.error });
  } catch (err) {
    console.error("Confirm API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
