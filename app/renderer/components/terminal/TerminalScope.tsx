import type { ReactNode } from "react";
import { clientSetting } from "@shigomori/contracts/schemas";
import { activeTheme } from "@shigomori/ui/lib/themes.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useLook } from "@/hooks/ui/useLook";

// The terminals' own theme root, the way a Settings swatch is one
// (DESIGN.md, "Theming"): the window's look, and while terminals stay
// dark in a light window, the light palette's own dark ("ink",
// palettes.css) rather than the dark pick. Always a root, so a
// terminal watching it re-themes in place when either changes.
export function TerminalScope({ children }: { children: ReactNode }) {
  const { data: config } = useClientConfig();
  const { applied, resolved } = useLook();
  const darkened =
    resolved === "light" && clientSetting(config ?? {}, "darkTerminals");
  const palette =
    darkened && applied.doubutsu ? "ink" : activeTheme(applied, resolved);
  return (
    <div
      data-theme-scope
      data-palette={palette ?? undefined}
      className={cn(
        "contents",
        (darkened || resolved === "dark") && "dark",
        applied.doubutsu && "doubutsu",
      )}
    >
      {children}
    </div>
  );
}
