"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  connected: boolean;
}

export function GithubConnect({ connected }: Props) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  function handleConnect() {
    window.location.href = "/api/integrations/github/start";
  }

  async function handleDisconnect() {
    setWorking(true);
    try {
      await fetch("/api/integrations/github/disconnect", { method: "POST" });
      router.refresh();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-2">
      {connected ? (
        <div className="flex items-center justify-between rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <p className="text-sm">
            <span className="font-medium text-green-600">Conectado</span>{" "}
            <span className="text-neutral-500">— el agente puede usar tus repos e issues.</span>
          </p>
          <button
            onClick={handleDisconnect}
            disabled={working}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:hover:bg-red-950"
          >
            {working ? "Desconectando..." : "Desconectar"}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-neutral-500">
            Conecta tu cuenta de GitHub para que el agente pueda listar repos, listar/crear issues y crear repositorios.
          </p>
          <button
            onClick={handleConnect}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Conectar GitHub
          </button>
        </div>
      )}
    </div>
  );
}
