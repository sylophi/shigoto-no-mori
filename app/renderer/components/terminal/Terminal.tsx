import { useState } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { exitSentinel } from "@/hooks/scripts/scriptRuns";
import { attachTerminal } from "@/lib/terminalFeed";
import {
  TerminalView,
  type TerminalFeed,
} from "@shigomori/ui/views/terminal/TerminalView.tsx";
import { useOutside } from "@shigomori/ui/outside.tsx";

// One of the scoped device's terminals, attached for as long as it is
// on screen.
export function Terminal({ terminalId }: { terminalId: string }) {
  const { api } = useHostScope();
  const { openUrl } = useOutside();
  const [ended, setEnded] = useState(false);
  // Kept the same while the device and the terminal are (React
  // Compiler), so the view attaches once.
  // A shell that was killed stays, its end marked as a script's is.
  // Any other leaves with its tab.
  const feed: TerminalFeed = (screen) =>
    attachTerminal(api, terminalId, screen, (code) => {
      if (code !== null && code !== 0) screen.write(exitSentinel(code));
      setEnded(true);
    });
  return (
    <TerminalView
      feed={feed}
      live={!ended}
      // A keystroke or a size for a shell on its way out is not worth
      // telling: its end shows.
      onInput={(data) =>
        void api.run(api.terminals.write({ terminalId, data })).catch(() => {})
      }
      onFit={(cols, rows) =>
        void api
          .run(api.terminals.resize({ terminalId, cols, rows }))
          .catch(() => {})
      }
      onLink={openUrl}
    />
  );
}
