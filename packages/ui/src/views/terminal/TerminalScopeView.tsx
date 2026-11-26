import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

// The terminals' own theme root (DESIGN.md, "Theming"), box-less unless
// it is given a frame's classes.
export function TerminalScopeView({
  palette,
  dark,
  doubutsu,
  className = "contents",
  children,
}: {
  palette: string | undefined;
  dark: boolean;
  doubutsu: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-theme-scope
      data-palette={palette}
      className={cn(className, dark && "dark", doubutsu && "doubutsu")}
    >
      {children}
    </div>
  );
}
