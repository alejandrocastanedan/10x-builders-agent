import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "notion_search",
    name: "notion_search",
    description:
      "Searches across all Notion pages and databases that the user has shared with the integration.",
    risk: "low",
    requires_integration: "notion",
    parameters_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        filter: { type: "string", enum: ["page", "database"] },
        page_size: { type: "number", description: "Max results (1-50)" },
      },
      required: ["query"],
    },
  },
  {
    id: "notion_retrieve_page",
    name: "notion_retrieve_page",
    description: "Retrieves a Notion page by its ID.",
    risk: "low",
    requires_integration: "notion",
    parameters_schema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    id: "notion_query_database",
    name: "notion_query_database",
    description: "Queries a Notion database and returns its rows.",
    risk: "low",
    requires_integration: "notion",
    parameters_schema: {
      type: "object",
      properties: {
        database_id: { type: "string" },
        page_size: { type: "number", description: "Max rows (1-50)" },
      },
      required: ["database_id"],
    },
  },
  {
    id: "notion_create_page",
    name: "notion_create_page",
    description:
      "Creates a new Notion page under a parent page or database. Requires confirmation.",
    risk: "high",
    requires_integration: "notion",
    parameters_schema: {
      type: "object",
      properties: {
        parent_page_id: {
          type: "string",
          description: "ID of the parent page (omit if using parent_database_id).",
        },
        parent_database_id: {
          type: "string",
          description: "ID of the parent database (omit if using parent_page_id).",
        },
        title: { type: "string" },
        content: { type: "string", description: "Optional initial paragraph body." },
      },
      required: ["title"],
    },
  },
  {
    id: "notion_append_paragraph",
    name: "notion_append_paragraph",
    description:
      "Appends a paragraph block to an existing Notion page or block. Requires confirmation.",
    risk: "medium",
    requires_integration: "notion",
    parameters_schema: {
      type: "object",
      properties: {
        block_id: { type: "string", description: "Page or block ID to append to." },
        text: { type: "string" },
      },
      required: ["block_id", "text"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description:
      "Creates a new repository in the authenticated user's GitHub account. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        private: { type: "boolean", description: "Make the repo private." },
        description: { type: "string" },
      },
      required: ["name"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
