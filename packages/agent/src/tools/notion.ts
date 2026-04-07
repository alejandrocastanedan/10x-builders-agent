/**
 * Minimal Notion REST client. Uses fetch + bearer token (OAuth user token).
 * Each function takes the access token as the first argument so the caller
 * controls the secret lifetime.
 */

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Error type that separates the HTTP status (safe to surface to users) from
 * the verbose Notion detail (which can leak page IDs, property names, and
 * other workspace internals — kept server-side only).
 */
export class NotionApiError extends Error {
  status: number;
  statusText: string;
  detail: string;

  constructor(status: number, statusText: string, detail: string) {
    super(`Notion ${status} ${statusText}`);
    this.name = "NotionApiError";
    this.status = status;
    this.statusText = statusText;
    this.detail = detail;
  }
}

async function notion<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Notion-Version": NOTION_VERSION,
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new NotionApiError(res.status, res.statusText, detail);
  }
  return (await res.json()) as T;
}

export interface NotionSearchResult {
  object: "page" | "database";
  id: string;
  url?: string;
  properties?: Record<string, unknown>;
  parent?: Record<string, unknown>;
}

export interface NotionPage {
  object: "page";
  id: string;
  url: string;
  archived: boolean;
  properties: Record<string, unknown>;
  parent: Record<string, unknown>;
}

/** POST /v1/search — query across all pages/databases shared with the integration. */
export async function searchNotion(
  token: string,
  query: string,
  filter?: "page" | "database",
  pageSize = 10
): Promise<{ results: NotionSearchResult[] }> {
  const body: Record<string, unknown> = {
    query,
    page_size: Math.min(Math.max(pageSize, 1), 50),
  };
  if (filter) {
    body.filter = { value: filter, property: "object" };
  }
  return notion<{ results: NotionSearchResult[] }>(token, `/search`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /v1/pages/{id} */
export async function retrievePage(
  token: string,
  pageId: string
): Promise<NotionPage> {
  return notion<NotionPage>(token, `/pages/${encodeURIComponent(pageId)}`);
}

/** POST /v1/databases/{id}/query */
export async function queryDatabase(
  token: string,
  databaseId: string,
  pageSize = 10
): Promise<{ results: NotionSearchResult[] }> {
  return notion<{ results: NotionSearchResult[] }>(
    token,
    `/databases/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        page_size: Math.min(Math.max(pageSize, 1), 50),
      }),
    }
  );
}

/**
 * POST /v1/pages — create a new page under a parent page or database.
 *
 * For a parent page, `title` becomes a single title block. For a database
 * parent, this helper assumes the database has a property called "Name" of
 * type title (the Notion default); if your database uses a different title
 * property name you'll need a richer wrapper.
 */
export async function createPage(
  token: string,
  parent: { page_id: string } | { database_id: string },
  title: string,
  content?: string
): Promise<NotionPage> {
  const isDatabase = "database_id" in parent;
  const properties: Record<string, unknown> = isDatabase
    ? {
        Name: {
          title: [{ type: "text", text: { content: title } }],
        },
      }
    : {
        title: [{ type: "text", text: { content: title } }],
      };

  const children = content
    ? [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content } }],
          },
        },
      ]
    : undefined;

  return notion<NotionPage>(token, `/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent,
      properties,
      ...(children ? { children } : {}),
    }),
  });
}

/** PATCH /v1/blocks/{id}/children — append a paragraph to an existing page/block. */
export async function appendParagraph(
  token: string,
  blockId: string,
  text: string
): Promise<{ results: unknown[] }> {
  return notion<{ results: unknown[] }>(
    token,
    `/blocks/${encodeURIComponent(blockId)}/children`,
    {
      method: "PATCH",
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: text } }],
            },
          },
        ],
      }),
    }
  );
}
