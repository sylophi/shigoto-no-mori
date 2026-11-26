import type { ReactNode } from "react";
import { clientSetting } from "@shigomori/contracts/schemas";
import { activeTheme } from "@shigomori/ui/lib/themes.ts";
import { TerminalScopeView } from "@shigomori/ui/views/terminal/TerminalScopeView.tsx";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useLook } from "@/hooks/ui/useLook";

// The terminals' own theme root, the way a Settings swatch is one
// (DESIGN.md, "Theming"): the window's look, and while terminals stay
// dark in a light window, the light palette's own terminal dark
// (palettes.css) rather than the dark pick. Always a root, so a
// terminal watching it re-themes in place when either changes.
export function TerminalScope({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { data: config } = useClientConfig();
  const { applied, resolved } = useLook();
  const darkened =
    resolved === "light" && clientSetting(config ?? {}, "darkTerminals");
  const theme = activeTheme(applied, resolved);
  const palette = darkened && theme ? `terminal-${theme}` : theme;
  return (
    <TerminalScopeView
      palette={palette ?? undefined}
      dark={darkened || resolved === "dark"}
      doubutsu={applied.doubutsu}
      className={className}
    >
      {children}
    </TerminalScopeView>
  );
}
