import { StateGraph, Annotation, MemorySaver } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type {
  UserToolSetting,
  UserIntegration,
  PendingConfirmation,
} from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools, isPendingMarker, PENDING_MARKER } from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  pendingConfirmation: Annotation<PendingConfirmation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationTokens: { github?: string; notion?: string };
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
}

const MAX_TOOL_ITERATIONS = 6;

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    integrationTokens,
  } = input;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    integrationTokens,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const history = await getSessionMessages(db, sessionId, 30);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  await addMessage(db, sessionId, "user", message);

  const toolCallNames: string[] = [];
  // Captured by closure so the conditional edge can read it after the tool node runs.
  // Typed via container so TS doesn't narrow it to `null` after initialization.
  const pendingHolder: { value: PendingConfirmation | null } = { value: null };

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];
    let pending: PendingConfirmation | null = null;

    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (!matchingTool) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (matchingTool as any).invoke(tc.args);

      if (isPendingMarker(result)) {
        pending = result[PENDING_MARKER];
        // Emit a placeholder ToolMessage so the AI tool_call is closed cleanly.
        results.push(
          new ToolMessage({
            content: "Awaiting user confirmation.",
            tool_call_id: tc.id!,
          })
        );
        // Stop processing further tool calls in this batch.
        break;
      }

      results.push(
        new ToolMessage({
          content: typeof result === "string" ? result : JSON.stringify(result),
          tool_call_id: tc.id!,
        })
      );
    }

    if (pending) {
      pendingHolder.value = pending;
      return { messages: results, pendingConfirmation: pending };
    }
    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    // Hard stop if we caught a pending confirmation in the previous tool node.
    if (state.pendingConfirmation) return "end";

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  function afterTools(state: typeof GraphState.State): string {
    // If a confirmation was just captured, end immediately.
    return state.pendingConfirmation ? "end" : "agent";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addConditionalEdges("tools", afterTools, {
      agent: "agent",
      end: "__end__",
    });

  const checkpointer = new MemorySaver();
  const app = graph.compile({ checkpointer });

  const initialMessages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...priorMessages,
    new HumanMessage(message),
  ];

  const finalState = await app.invoke(
    { messages: initialMessages, sessionId, userId, systemPrompt, pendingConfirmation: null },
    { configurable: { thread_id: sessionId } }
  );

  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  const captured = pendingHolder.value;

  // Persist the assistant message only if there is real text (not the placeholder).
  if (!captured && responseText && responseText !== "Awaiting user confirmation.") {
    await addMessage(db, sessionId, "assistant", responseText);
  }

  return {
    response: captured ? captured.message : responseText,
    toolCalls: toolCallNames,
    pendingConfirmation: captured,
  };
}
