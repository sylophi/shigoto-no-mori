import { useState } from "react";
import type { ShellSyntax } from "@shigomori/contracts/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { attachTerminal } from "@/lib/terminalFeed";
import { inputPieces } from "@/lib/terminalInput";
import { useApi } from "@/lib/runtime/pageApi";
import {
  TerminalView,
  type TerminalFeed,
} from "@shigomori/ui/views/terminal/TerminalView.tsx";
import { useOutside } from "@shigomori/ui/outside.tsx";

// One of the scoped device's terminals, attached for as long as it is
// on screen.
export function Terminal({
  terminalId,
  syntax,
}: {
  terminalId: string;
  syntax: ShellSyntax;
}) {
  const { api, remote } = useHostScope();
  const page = useApi();
  const { openUrl } = useOutside();
  const [ended, setEnded] = useState(false);
  // Kept the same while the device and the terminal are (React
  // Compiler), so the view attaches once.
  const feed: TerminalFeed = (screen) =>
    attachTerminal(api, terminalId, screen, () => setEnded(true));
  return (
    <TerminalView
      feed={feed}
      syntax={syntax}
      live={!ended}
      // A keystroke or a size for a shell on its way out is not worth
      // telling: its end shows.
      onInput={(data) => {
        for (const piece of inputPieces(data)) {
          void api
            .run(api.terminals.write({ terminalId, data: piece }))
            .catch(() => {});
        }
      }}
      onFit={(cols, rows) =>
        void api
          .run(api.terminals.resize({ terminalId, cols, rows }))
          .catch(() => {})
      }
      onLink={openUrl}
      // A file dropped here is on this machine, so another's shell
      // could not open its path.
      pathOfFile={remote ? undefined : page.pathOfFile}
    />
  );
}
