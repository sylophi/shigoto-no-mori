import { useEffect, useRef, useState } from "react";
import type { ScriptEvent, ScriptName } from "@shared/schemas";

const MAX_LOGS = 5_000;

export interface LogLine {
  id: number;
  stream: "stdout" | "stderr" | "error" | "exit";
  text: string;
}

export interface ScriptRunState {
  logs: LogLine[];
  running: boolean;
  exitCode: number | null;
  start: (input: {
    projectId: string;
    worktreeId: string;
    script: ScriptName;
  }) => Promise<void>;
  cancel: () => Promise<void>;
  clear: () => void;
}

function appendBounded(prev: LogLine[], entry: LogLine): LogLine[] {
  if (prev.length < MAX_LOGS) return [...prev, entry];
  return [...prev.slice(prev.length - MAX_LOGS + 1), entry];
}

export function useScriptRun(): ScriptRunState {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const activeRunId = useRef<string | null>(null);
  const nextLogId = useRef(0);

  useEffect(() => {
    const unsubscribe = window.api.scripts.onEvent((event: ScriptEvent) => {
      if (event.runId !== activeRunId.current) return;

      const id = nextLogId.current++;
      if (event.kind === "stdout" || event.kind === "stderr") {
        setLogs((prev) =>
          appendBounded(prev, { id, stream: event.kind, text: event.data }),
        );
        return;
      }
      if (event.kind === "error") {
        setLogs((prev) =>
          appendBounded(prev, { id, stream: "error", text: event.data }),
        );
        return;
      }
      if (event.kind === "exit") {
        setLogs((prev) =>
          appendBounded(prev, {
            id,
            stream: "exit",
            text: `Exited with code ${event.code ?? "(signal)"}`,
          }),
        );
        setExitCode(event.code);
        setRunning(false);
      }
    });
    return () => unsubscribe();
  }, []);

  return {
    logs,
    running,
    exitCode,
    start: async ({ projectId, worktreeId, script }) => {
      setLogs([]);
      setExitCode(null);
      setRunning(true);
      const { runId } = await window.api.scripts.run({
        projectId,
        worktreeId,
        script,
      });
      activeRunId.current = runId;
    },
    cancel: async () => {
      if (!activeRunId.current) return;
      await window.api.scripts.cancel(activeRunId.current);
    },
    clear: () => {
      setLogs([]);
      setExitCode(null);
      activeRunId.current = null;
    },
  };
}
