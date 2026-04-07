"use client";

import { useState, useRef, useEffect } from "react";

interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  message: string;
}

interface Message {
  role: string;
  content: string;
  created_at?: string;
  pending?: PendingConfirmation;
}

interface Props {
  agentName: string;
  initialMessages: Message[];
}

export function ChatInterface({ agentName, initialMessages }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (data.pendingConfirmation) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.pendingConfirmation.message,
            pending: data.pendingConfirmation,
          },
        ]);
      } else if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al procesar tu mensaje. Intenta de nuevo." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function resolveConfirmation(toolCallId: string, action: "approve" | "reject") {
    setResolvingId(toolCallId);
    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId, action }),
      });
      const data = await res.json();

      // Remove the pending state from the corresponding message
      setMessages((prev) =>
        prev.map((m) =>
          m.pending?.toolCallId === toolCallId ? { ...m, pending: undefined } : m
        )
      );

      // Append the result message
      let resultText: string;
      if (action === "reject") {
        resultText = "Acción cancelada.";
      } else if (data.ok && data.result) {
        const url =
          typeof data.result === "object" && data.result && "html_url" in data.result
            ? (data.result as { html_url: string }).html_url
            : null;
        resultText = url
          ? `Listo: ${url}`
          : `Listo: ${JSON.stringify(data.result)}`;
      } else {
        resultText = `Error: ${data.error ?? "no se pudo ejecutar la acción"}`;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: resultText }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al confirmar la acción." },
      ]);
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-neutral-400 py-20">
              <p className="text-lg font-medium text-neutral-600 dark:text-neutral-300">
                ¡Hola! Soy {agentName}
              </p>
              <p className="mt-1">Escribe un mensaje para comenzar.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
                {msg.pending && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => resolveConfirmation(msg.pending!.toolCallId, "approve")}
                      disabled={resolvingId === msg.pending.toolCallId}
                      className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {resolvingId === msg.pending.toolCallId ? "Ejecutando..." : "Aprobar"}
                    </button>
                    <button
                      onClick={() => resolveConfirmation(msg.pending!.toolCallId, "reject")}
                      disabled={resolvingId === msg.pending.toolCallId}
                      className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    >
                      Cancelar
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm dark:bg-neutral-800">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-2xl gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu mensaje..."
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
