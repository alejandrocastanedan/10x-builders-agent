# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run from the repo root unless noted. Turborepo fans out to every workspace.

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces (npm workspaces, no pnpm/yarn). |
| `npm run dev` | Start the Next.js dev server (Turbopack, HMR). Serves on http://localhost:3000. |
| `npm run build` | Production build of every package. |
| `npm run lint` | Lint everything. |
| `npm run type-check` | `tsc --noEmit` across all packages. **Always run this after touching `packages/*` or API routes** — the agent runtime is fully typed and many bugs surface here only. |
| `cd apps/web && npm run start` | Start the production server after `npm run build`. Required when exposing the app via ngrok (see "ngrok caveats" below). |

There is no test runner configured.

## High-level architecture

This is a personal-agent MVP. A user chats (web or Telegram) with an LLM-driven assistant that can call tools — some read data, some perform sensitive actions and require explicit human approval before running.

### Monorepo layout

```
apps/web              Next.js 16 app: UI, API routes, OAuth callbacks, Telegram webhook
packages/agent        LangGraph runtime, tool catalog, GitHub REST client, shared executor
packages/db           Supabase clients (server/browser), typed queries, AES-256-GCM crypto
packages/types        Shared TypeScript interfaces (Profile, ToolCall, PendingConfirmation, ...)
packages/config       Shared tsconfig bases
docs/                 brief.md, architecture.md, plan.md
```

Workspaces are aliased as `@agents/web`, `@agents/agent`, `@agents/db`, `@agents/types`, `@agents/config`.

### Request flow (web chat)

```
ChatInterface (client)
  → POST /api/chat
      → Supabase auth (cookies)
      → load profile, user_tool_settings, user_integrations
      → getIntegrationByProvider(db, userId, "github") → decryptToken(...)  ← only place tokens leave the DB
      → getOrCreateSession(channel="web")
      → runAgent({ ..., integrationTokens: { github } })
  ← { response, pendingConfirmation, toolCalls }
```

`runAgent` lives in `packages/agent/src/graph.ts`. It builds a LangGraph `StateGraph` with two nodes (`agent`, `tools`) and runs the model with bound tools until either (a) the model returns no `tool_calls` or (b) a tool returns a `PendingMarker` (see below). It persists the user message and the assistant reply to `agent_messages` and returns a structured `AgentOutput` containing `pendingConfirmation` (the new contract — never parse the response text to detect this).

### The confirmation mechanism (the most important invariant)

Tools with `risk: "medium" | "high"` must **never** execute themselves. The flow is:

1. The adapter in [packages/agent/src/tools/adapters.ts](packages/agent/src/tools/adapters.ts) creates a `tool_calls` row with `status: "pending_confirmation"` and returns a special object: `{ __pendingConfirmation: { toolCallId, toolName, arguments, message } }`.
2. `toolExecutorNode` in [packages/agent/src/graph.ts](packages/agent/src/graph.ts) detects this object via `isPendingMarker(...)`, captures it into a closure-scoped holder, emits a placeholder `ToolMessage`, and breaks the loop for that batch.
3. A new conditional edge (`afterTools`) routes straight to `__end__` instead of going back to the `agent` node, so the model is never asked to "decide what to do next" — the loop is hard-stopped.
4. `runAgent` returns `pendingConfirmation` as a structured field. Both `/api/chat/route.ts` and `apps/web/src/app/api/telegram/webhook/route.ts` consume that field directly. **Do not** add `response.includes("pending_confirmation")` or `JSON.parse(response)` — that's the old broken contract that this rewrite removed.
5. Resolution is button-only:
   - **Web**: `chat-interface.tsx` renders Aprobar/Cancelar buttons that POST to `/api/chat/confirm` with `{ toolCallId, action }`. That endpoint loads the row, decrypts the GitHub token, and runs `executeTool(...)` from [packages/agent/src/tools/executor.ts](packages/agent/src/tools/executor.ts).
   - **Telegram**: inline buttons send `approve:<id>` / `reject:<id>` callback queries; the webhook handler runs the same `executeTool(...)`.
6. `executor.ts` is the **single source of truth** for the real tool implementation. The adapter, the confirm endpoint, and the Telegram handler all go through it. If you add a new tool, add it to `catalog.ts`, wire it in `adapters.ts` via `wrapTool(...)`, and add a `case` in `executor.ts`.

### OAuth + token storage

GitHub uses a classic OAuth App (client_id + client_secret in env). The flow is implemented from scratch — no `next-auth`, no `@octokit`:

- `/api/integrations/github/start` generates a 32-byte CSRF `state`, stores it in an httpOnly cookie (`secure` is conditional on the redirect URL being `https://` so localhost dev still works), and redirects to `github.com/login/oauth/authorize`.
- `/api/integrations/github/callback` validates the cookie state, exchanges the code for an `access_token`, **encrypts it with `encryptToken()` from `packages/db/src/crypto.ts` (AES-256-GCM, key = `OAUTH_ENCRYPTION_KEY` as 32-byte hex)**, and stores it via `upsertIntegration` in `user_integrations.encrypted_tokens`. It also auto-enables the four GitHub tools so the agent can use them immediately.
- `getIntegrationByProvider` is the only query that returns `encrypted_tokens`. The public `UserIntegration` type in `packages/types` deliberately omits that column.
- Decryption only happens server-side, just before calling `runAgent` or `executeTool`. Tokens are never logged or returned to the client.

### Data model

Migration: [packages/db/supabase/migrations/00001_initial_schema.sql](packages/db/supabase/migrations/00001_initial_schema.sql). Apply manually via Supabase SQL Editor on a fresh project.

Tables:
- `profiles` — extends `auth.users` (auto-created via `handle_new_user` trigger).
- `user_integrations` — OAuth tokens, **stored encrypted**, unique per `(user_id, provider)`.
- `user_tool_settings` — per-user tool enable/disable.
- `agent_sessions` — one per `(user_id, channel)`; `channel ∈ {web, telegram}`.
- `agent_messages` — chat history.
- `tool_calls` — full audit trail with status `pending_confirmation | approved | rejected | executed | failed`.
- `telegram_accounts` + `telegram_link_codes` — one-time codes (10 min expiry) for linking Telegram users.

**Every table has RLS** filtering by `auth.uid()`. Server-side code that needs to bypass RLS uses `createServerClient()` from `@agents/db` (service role key) and validates `userId` explicitly before doing anything sensitive.

### LLM provider

`packages/agent/src/model.ts` instantiates `ChatOpenAI` against **OpenRouter** (`openai/gpt-4o-mini` by default). To swap models, edit that file. The system prompt is per-user (`profiles.agent_system_prompt`).

## Critical conventions and gotchas

- **Next.js 16 has breaking changes vs your training data.** [apps/web/AGENTS.md](apps/web/AGENTS.md) says: read `node_modules/next/dist/docs/` before writing Next code. Specifically: the `middleware.ts` file convention is deprecated in favor of `proxy.ts`; the dev server warns about this on every start.
- **Env files live in `apps/web/.env.local`, not in the repo root.** Next.js loads them from the app directory. The root `.gitignore` covers `.env*`.
- **`OAUTH_ENCRYPTION_KEY` must be 32 bytes hex (64 chars).** The crypto module throws on the first call if it's missing or wrong length. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **Adding a new tool** = three files: `catalog.ts` (definition + risk), `adapters.ts` (LangChain `tool()` wiring via `wrapTool`), `executor.ts` (real implementation). Skip any of the three and you'll either get "Unknown tool" at execution time or a tool the agent can't see.
- **GitHub callback URL** in `github.com/settings/developers` must match `GITHUB_OAUTH_REDIRECT_URL` exactly. When switching between localhost and an ngrok URL, update both the GitHub OAuth App settings AND `.env.local`.

## ngrok caveats (recurring pain point)

Free-tier ngrok with Next.js dev mode does **not** work for browser-driven flows:

- ngrok-free blocks the `wss://` HMR WebSocket, so React **never hydrates** the page. Buttons render as static HTML and click handlers never fire — including the "Conectar GitHub" button. Login forms also appear to do nothing.
- `*.ngrok-free.dev` is on the Public Suffix List, which makes browsers refuse to persist Supabase auth cookies. Even after solving hydration, login won't stick.

Workarounds, in order of preference:
1. **Do all UI work on `http://localhost:3000` directly.** It's faster and HMR works.
2. **For Telegram webhooks** (server-to-server, no browser, no cookies), ngrok is fine — that's its only legitimate use here.
3. **If you must demo via ngrok**, use `npm run build && cd apps/web && npm run start` (production mode, no HMR needed) AND launch the browser in incognito to avoid stale cookies.

When adding `ngrok http 3000`, prefer `--host-header=rewrite` so Next sees the upstream `Host` as `localhost:3000`.

## Useful files to read first

- `packages/agent/src/graph.ts` — the LangGraph state machine and `runAgent` entry point.
- `packages/agent/src/tools/executor.ts` — single dispatch point for real tool calls.
- `packages/agent/src/tools/adapters.ts` — how tools are exposed to the model and how the confirmation marker works.
- `apps/web/src/app/api/chat/route.ts` and `apps/web/src/app/api/chat/confirm/route.ts` — the two endpoints that drive the web chat.
- `apps/web/src/app/api/telegram/webhook/route.ts` — full Telegram flow including `/start`, `/link CODE`, message handling, and inline-button confirmations.
- `packages/db/supabase/migrations/00001_initial_schema.sql` — authoritative data model with RLS policies.
- `docs/architecture.md` — original architecture brief (the structured-confirmation rewrite is newer than this doc).
