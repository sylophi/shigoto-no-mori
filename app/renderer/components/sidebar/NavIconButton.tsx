import type React from "react";
import {
  useLocation,
  useNavigate,
  type NavigateOptions,
} from "@tanstack/react-router";
import { NavIconButtonView } from "./SidebarFooterView";

// One shape for the sidebar's route buttons (NavIconButtonView), its
// active highlight derived from the current location. The match is
// exact: /devices/$deviceId/... is a device's WORKTREE (this machine's
// or a peer's), which is meant to read as ordinary work rather than as
// a device page, so it must not light this button.
export function NavIconButton({
  to,
  tip,
  label,
  children,
}: {
  to: NavigateOptions["to"];
  tip: string;
  label: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <NavIconButtonView
      tip={tip}
      label={label}
      active={location.pathname === to}
      onClick={() => void navigate({ to })}
    >
      {children}
    </NavIconButtonView>
  );
}
