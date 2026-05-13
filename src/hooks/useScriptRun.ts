import { useEffect, useRef, useState } from "react";
import type { ScriptEvent, ScriptName } from "@shared/schemas";

export interface LogLine {
  id: number;
  stream: "stdout" | "stderr" | "error" | "exit";
  text: string;
}

export interface ScriptRunState {
  logs: LogLine[];
  running: boolean;
  runId: string | null;
  exitCode: number | null;
  start: (input: {
    projectId: string;
    worktreeId: string;
    script: ScriptName;
  }) => Promise<void>;
  cancel: () => Promise<void>;
  clear: () => void;
}

export function useScriptRun(): ScriptRunState {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const activeRunId = useRef<string | null>(null);
  const nextLogId = useRef(0);

  useEffect(() => {
    const unsubscribe = window.api.scripts.onEvent((event: ScriptEvent) => {
      if (event.runId !== activeRunId.current) return;
      if (event.kind === "stdout" || event.kind === "stderr") {
        setLogs((prev) => [
          ...prev,
          { id: nextLogId.current++, stream: event.kind, text: event.data },
        ]);
        return;
      }
      if (event.kind === "error") {
        setLogs((prev) => [
          ...prev,
          { id: nextLogId.current++, stream: "error", text: event.data },
        ]);
        return;
      }
      if (event.kind === "exit") {
        setLogs((prev) => [
          ...prev,
          {
            id: nextLogId.current++,
            stream: "exit",
            text: `Exited with code ${event.code ?? "(signal)"}`,
          },
        ]);
        setExitCode(event.code);
        setRunning(false);
      }
    });
    return () => unsubscribe();
  }, []);

  return {
    logs,
    running,
    runId,
    exitCode,
    start: async ({ projectId, worktreeId, script }) => {
      setLogs([]);
      setExitCode(null);
      setRunning(true);
      const { runId: newRunId } = await window.api.scripts.run({
        projectId,
        worktreeId,
        script,
      });
      activeRunId.current = newRunId;
      setRunId(newRunId);
    },
    cancel: async () => {
      if (!activeRunId.current) return;
      await window.api.scripts.cancel(activeRunId.current);
    },
    clear: () => {
      setLogs([]);
      setExitCode(null);
      activeRunId.current = null;
      setRunId(null);
    },
  };
}
