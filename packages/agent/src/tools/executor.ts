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

export interface ExecutorContext {
  db: DbClient;
  userId: string;
  enabledTools: UserToolSetting[];
  integrationTokens: { github?: string };
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

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
