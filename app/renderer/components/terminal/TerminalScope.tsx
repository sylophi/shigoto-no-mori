import type { ReactNode } from "react";
import { clientSetting } from "@shigomori/contracts/schemas";
import { activeTheme } from "@shigomori/ui/lib/themes.ts";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { usePalette } from "@/hooks/ui/usePalette";
import { useTheme } from "@/hooks/ui/useTheme";

// The terminals' own theme root, the way a Settings swatch is one
// (DESIGN.md, "Theming"): the window's look, or its dark one while
// terminals stay dark. Always a root, so a terminal watching it
// re-themes in place when either changes.
export function TerminalScope({ children }: { children: ReactNode }) {
  const { data: config } = useClientConfig();
  const { applied } = usePalette();
  const { resolved } = useTheme();
  const appearance = clientSetting(config ?? {}, "darkTerminals")
    ? "dark"
    : resolved;
  return (
    <div
      data-theme-scope
      data-palette={activeTheme(applied, appearance) ?? undefined}
      className={cn(
        "contents",
        appearance === "dark" && "dark",
        applied.doubutsu && "doubutsu",
      )}
    >
      {children}
    </div>
  );
}
