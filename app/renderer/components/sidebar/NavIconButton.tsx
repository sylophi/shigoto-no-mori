import type React from "react";
import {
  useLocation,
  useNavigate,
  type NavigateOptions,
} from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

// One shape for the sidebar's route buttons (projects, devices,
// settings): icon, active highlight derived from the current location.
// The match is exact, so Projects ("/") doesn't light on every page.
export function NavIconButton({
  to,
  label,
  children,
}: {
  to: NavigateOptions["to"];
  label: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <button
      type="button"
      onClick={() => void navigate({ to })}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        SIDEBAR_ICON_BUTTON,
        "relative",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}
