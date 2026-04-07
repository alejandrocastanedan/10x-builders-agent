import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";
import { executeTool, type ExecutorContext } from "./executor";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationTokens: { github?: string; notion?: string };
}

/**
 * Marker object returned by a tool when execution is paused awaiting user
 * confirmation. The graph's tool executor node detects this object and stops
 * the loop instead of feeding the result back to the model.
 */
export const PENDING_MARKER = "__pendingConfirmation" as const;

export interface PendingMarker {
  [PENDING_MARKER]: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    message: string;
  };
}

export function isPendingMarker(value: unknown): value is PendingMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    PENDING_MARKER in (value as Record<string, unknown>)
  );
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

function executorContextFor(ctx: ToolContext): ExecutorContext {
  return {
    db: ctx.db,
    userId: ctx.userId,
    enabledTools: ctx.enabledTools,
    integrationTokens: ctx.integrationTokens,
  };
}

/**
 * Wraps a tool body so the runtime: (1) creates a tool_call row, (2) checks
 * the risk level — if confirmation is required it returns a PendingMarker
 * immediately without executing, otherwise it runs the executor and updates
 * the status to executed/failed.
 */
function wrapTool(
  toolId: string,
  args: Record<string, unknown>,
  message: string,
  ctx: ToolContext
) {
  return async (): Promise<unknown> => {
    const needsConfirm = toolRequiresConfirmation(toolId);
    const record = await createToolCall(
      ctx.db,
      ctx.sessionId,
      toolId,
      args,
      needsConfirm
    );

    if (needsConfirm) {
      const marker: PendingMarker = {
        [PENDING_MARKER]: {
          toolCallId: record.id,
          toolName: toolId,
          arguments: args,
          message,
        },
      };
      return marker;
    }

    const result = await executeTool(toolId, args, executorContextFor(ctx));
    if (result.ok) {
      await updateToolCallStatus(ctx.db, record.id, "executed", result.data);
      return JSON.stringify(result.data ?? {});
    }
    await updateToolCallStatus(ctx.db, record.id, "failed", {
      error: result.error,
    });
    return JSON.stringify({ error: result.error });
  };
}

export function buildLangChainTools(ctx: ToolContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        wrapTool(
          "get_user_preferences",
          {},
          "Get user preferences",
          ctx
        ),
        {
          name: "get_user_preferences",
          description:
            "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        wrapTool("list_enabled_tools", {}, "List enabled tools", ctx),
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "github_list_repos",
            input as Record<string, unknown>,
            "List GitHub repositories",
            ctx
          )(),
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "github_list_issues",
            input as Record<string, unknown>,
            `List issues for ${input.owner}/${input.repo}`,
            ctx
          )(),
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "github_create_issue",
            input as Record<string, unknown>,
            `Crear issue "${input.title}" en ${input.owner}/${input.repo}`,
            ctx
          )(),
        {
          name: "github_create_issue",
          description:
            "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "github_create_repo",
            input as Record<string, unknown>,
            `Crear repositorio "${input.name}"${input.private ? " (privado)" : ""}`,
            ctx
          )(),
        {
          name: "github_create_repo",
          description:
            "Creates a new repository in the authenticated user's account. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            private: z.boolean().optional().default(false),
            description: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("notion_search", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "notion_search",
            input as Record<string, unknown>,
            `Buscar en Notion: "${input.query}"`,
            ctx
          )(),
        {
          name: "notion_search",
          description:
            "Searches across all Notion pages and databases shared with the integration.",
          schema: z.object({
            query: z.string(),
            filter: z.enum(["page", "database"]).optional(),
            page_size: z.number().min(1).max(50).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("notion_retrieve_page", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "notion_retrieve_page",
            input as Record<string, unknown>,
            `Recuperar página Notion ${input.page_id}`,
            ctx
          )(),
        {
          name: "notion_retrieve_page",
          description: "Retrieves a Notion page by its ID.",
          schema: z.object({
            page_id: z.string(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("notion_query_database", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "notion_query_database",
            input as Record<string, unknown>,
            `Consultar base de datos Notion ${input.database_id}`,
            ctx
          )(),
        {
          name: "notion_query_database",
          description: "Queries a Notion database and returns its rows.",
          schema: z.object({
            database_id: z.string(),
            page_size: z.number().min(1).max(50).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("notion_create_page", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "notion_create_page",
            input as Record<string, unknown>,
            `Crear página Notion "${input.title}"`,
            ctx
          )(),
        {
          name: "notion_create_page",
          description:
            "Creates a new Notion page under a parent page or database. Requires confirmation.",
          schema: z
            .object({
              parent_page_id: z.string().optional(),
              parent_database_id: z.string().optional(),
              title: z.string(),
              content: z.string().optional().default(""),
            })
            .refine(
              (v) => Boolean(v.parent_page_id) !== Boolean(v.parent_database_id),
              { message: "Provide exactly one of parent_page_id or parent_database_id." }
            ),
        }
      )
    );
  }

  if (isToolAvailable("notion_append_paragraph", ctx)) {
    tools.push(
      tool(
        async (input) =>
          wrapTool(
            "notion_append_paragraph",
            input as Record<string, unknown>,
            `Añadir párrafo a Notion ${input.block_id}`,
            ctx
          )(),
        {
          name: "notion_append_paragraph",
          description:
            "Appends a paragraph block to an existing Notion page or block. Requires confirmation.",
          schema: z.object({
            block_id: z.string(),
            text: z.string(),
          }),
        }
      )
    );
  }

  return tools;
}
