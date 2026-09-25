import { Rocket, Terminal, Trash2 } from "lucide-react";
import { assertNever } from "@/lib/utils";
import type { ScriptActivityKind } from "@/store/scriptRuns";

interface ActivityIconProps {
  kind: ScriptActivityKind;
}

export function ActivityIcon({ kind }: ActivityIconProps) {
  switch (kind) {
    case "setup":
      return (
        <Rocket
          aria-label="Setup running"
          className="size-3 shrink-0 animate-pulse text-emerald-500"
        />
      );
    case "teardown":
      return (
        <Trash2
          aria-label="Teardown running"
          className="size-3 shrink-0 animate-pulse text-destructive"
        />
      );
    case "package":
      return (
        <Terminal
          aria-label="Script running"
          className="size-3 shrink-0 animate-pulse text-violet-500"
        />
      );
    default:
      return assertNever(kind);
  }
}
