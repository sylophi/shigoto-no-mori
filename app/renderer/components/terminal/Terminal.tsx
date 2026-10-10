import { useState } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { openExternalUrl } from "@/lib/openExternal";
import { attachTerminal } from "@/lib/terminalFeed";
import { TerminalView, type TerminalFeed } from "./TerminalView";

// One of the scoped device's terminals, attached for as long as it is
// on screen.
export function Terminal({ terminalId }: { terminalId: string }) {
  const { api } = useHostScope();
  const [ended, setEnded] = useState(false);
  // Kept the same while the device and the terminal are (React
  // Compiler), so the view attaches once.
  const feed: TerminalFeed = (screen) =>
    attachTerminal(api, terminalId, screen, () => setEnded(true));
  return (
    <TerminalView
      feed={feed}
      live={!ended}
      // A keystroke or a size for a shell on its way out is not worth
      // telling: its end shows.
      onInput={(data) =>
        void api.terminals.write({ terminalId, data }).catch(() => {})
      }
      onFit={(cols, rows) =>
        void api.terminals.resize({ terminalId, cols, rows }).catch(() => {})
      }
      onLink={openExternalUrl}
    />
  );
}
