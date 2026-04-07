/**
 * Shared tool executor: takes a tool name + arguments + integration tokens
 * and runs the real implementation, returning a JSON-serializable result.
 *
 * This is reused by:
 *  - adapters.ts (low-risk tools that execute immediately)
 *  - /api/chat/confirm (when the user approves a pending tool call in web)
 *  - telegram/webhook (when the user approves via inline buttons)
 */

import { getProfile } from "@agents/db";
import type { DbClient } from "@agents/db";
import type { UserToolSetting } from "@agents/types";
import {
  listRepos,
  listIssues,
  createIssue,
  createRepo,
} from "./github";
import {
  searchNotion,
  retrievePage,
  queryDatabase,
  createPage,
  appendParagraph,
  NotionApiError,
} from "./notion";

export interface ExecutorContext {
  db: DbClient;
  userId: string;
  enabledTools: UserToolSetting[];
  integrationTokens: { github?: string; notion?: string };
}

export interface ExecutorResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

function requireGithubToken(ctx: ExecutorContext): string {
  if (!ctx.integrationTokens.github) {
    throw new Error("GitHub no está conectado para este usuario.");
  }
  return ctx.integrationTokens.github;
}

function requireNotionToken(ctx: ExecutorContext): string {
  if (!ctx.integrationTokens.notion) {
    throw new Error("Notion no está conectado para este usuario.");
  }
  return ctx.integrationTokens.notion;
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ExecutorContext
): Promise<ExecutorResult> {
  try {
    switch (toolName) {
      case "get_user_preferences": {
        const profile = await getProfile(ctx.db, ctx.userId);
        return {
          ok: true,
          data: {
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          },
        };
      }

      case "list_enabled_tools": {
        const enabled = ctx.enabledTools
          .filter((t) => t.enabled)
          .map((t) => t.tool_id);
        return { ok: true, data: { enabled } };
      }

      case "github_list_repos": {
        const token = requireGithubToken(ctx);
        const perPage = typeof args.per_page === "number" ? args.per_page : 10;
        const repos = await listRepos(token, perPage);
        return {
          ok: true,
          data: {
            repos: repos.map((r) => ({
              full_name: r.full_name,
              private: r.private,
              html_url: r.html_url,
              description: r.description,
            })),
          },
        };
      }

      case "github_list_issues": {
        const token = requireGithubToken(ctx);
        const owner = String(args.owner ?? "");
        const repo = String(args.repo ?? "");
        const state = (args.state as "open" | "closed" | "all") ?? "open";
        const issues = await listIssues(token, owner, repo, state);
        return {
          ok: true,
          data: {
            issues: issues.map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              html_url: i.html_url,
              user: i.user.login,
            })),
          },
        };
      }

      case "github_create_issue": {
        const token = requireGithubToken(ctx);
        const owner = String(args.owner ?? "");
        const repo = String(args.repo ?? "");
        const title = String(args.title ?? "");
        const body = args.body ? String(args.body) : "";
        const issue = await createIssue(token, owner, repo, title, body);
        return {
          ok: true,
          data: {
            number: issue.number,
            title: issue.title,
            html_url: issue.html_url,
          },
        };
      }

      case "github_create_repo": {
        const token = requireGithubToken(ctx);
        const name = String(args.name ?? "");
        const isPrivate = Boolean(args.private ?? false);
        const description = args.description ? String(args.description) : "";
        const repo = await createRepo(token, name, {
          private: isPrivate,
          description,
        });
        return {
          ok: true,
          data: {
            full_name: repo.full_name,
            private: repo.private,
            html_url: repo.html_url,
          },
        };
      }

      case "notion_search": {
        const token = requireNotionToken(ctx);
        const query = String(args.query ?? "");
        const filter =
          args.filter === "page" || args.filter === "database"
            ? (args.filter as "page" | "database")
            : undefined;
        const pageSize =
          typeof args.page_size === "number" ? args.page_size : 10;
        const data = await searchNotion(token, query, filter, pageSize);
        return {
          ok: true,
          data: {
            results: (data.results ?? []).map((r) => ({
              object: r.object,
              id: r.id,
              url: r.url,
            })),
          },
        };
      }

      case "notion_retrieve_page": {
        const token = requireNotionToken(ctx);
        const pageId = String(args.page_id ?? "");
        const page = await retrievePage(token, pageId);
        return {
          ok: true,
          data: {
            id: page.id,
            url: page.url,
            archived: page.archived,
            properties: page.properties,
          },
        };
      }

      case "notion_query_database": {
        const token = requireNotionToken(ctx);
        const databaseId = String(args.database_id ?? "");
        const pageSize =
          typeof args.page_size === "number" ? args.page_size : 10;
        const data = await queryDatabase(token, databaseId, pageSize);
        return {
          ok: true,
          data: {
            results: (data.results ?? []).map((r) => ({
              object: r.object,
              id: r.id,
              url: r.url,
            })),
          },
        };
      }

      case "notion_create_page": {
        const token = requireNotionToken(ctx);
        const title = String(args.title ?? "");
        const content = args.content ? String(args.content) : undefined;
        const parentPageId = args.parent_page_id
          ? String(args.parent_page_id)
          : undefined;
        const parentDatabaseId = args.parent_database_id
          ? String(args.parent_database_id)
          : undefined;
        if (!parentPageId && !parentDatabaseId) {
          return {
            ok: false,
            error: "Debes indicar parent_page_id o parent_database_id.",
          };
        }
        const parent = parentDatabaseId
          ? { database_id: parentDatabaseId }
          : { page_id: parentPageId! };
        const page = await createPage(token, parent, title, content);
        return {
          ok: true,
          data: {
            id: page.id,
            url: page.url,
          },
        };
      }

      case "notion_append_paragraph": {
        const token = requireNotionToken(ctx);
        const blockId = String(args.block_id ?? "");
        const text = String(args.text ?? "");
        await appendParagraph(token, blockId, text);
        return {
          ok: true,
          data: { block_id: blockId, appended: true },
        };
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Notion error detail can include page IDs, property names and other
    // workspace internals — log server-side, surface only the status to the
    // LLM/user.
    if (err instanceof NotionApiError) {
      console.error(
        `[notion ${err.status} ${err.statusText}] ${err.detail || "(no detail)"}`
      );
      return {
        ok: false,
        error: `Notion request failed (${err.status} ${err.statusText}).`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
