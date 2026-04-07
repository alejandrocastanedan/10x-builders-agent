/**
 * Minimal GitHub REST client. Uses fetch + bearer token (OAuth user token).
 * Each function takes the access token as the first argument so the caller
 * controls the secret lifetime.
 */

const GH_BASE = "https://api.github.com";

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${GH_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body?.message ? `: ${body.message}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`GitHub ${res.status} ${res.statusText}${detail}`);
  }
  return (await res.json()) as T;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
}

export interface GhIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string };
}

export interface GhUser {
  login: string;
  id: number;
  name: string | null;
}

export async function getAuthenticatedUser(token: string): Promise<GhUser> {
  return gh<GhUser>(token, "/user");
}

export async function listRepos(
  token: string,
  perPage = 10
): Promise<GhRepo[]> {
  const data = await gh<GhRepo[]>(
    token,
    `/user/repos?per_page=${Math.min(Math.max(perPage, 1), 100)}&sort=updated`
  );
  return data;
}

export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open"
): Promise<GhIssue[]> {
  return gh<GhIssue[]>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}`
  );
}

export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body?: string
): Promise<GhIssue> {
  return gh<GhIssue>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: "POST",
      body: JSON.stringify({ title, body: body ?? "" }),
    }
  );
}

export async function createRepo(
  token: string,
  name: string,
  options: { private?: boolean; description?: string } = {}
): Promise<GhRepo> {
  return gh<GhRepo>(token, `/user/repos`, {
    method: "POST",
    body: JSON.stringify({
      name,
      private: options.private ?? false,
      description: options.description ?? "",
      auto_init: true,
    }),
  });
}
