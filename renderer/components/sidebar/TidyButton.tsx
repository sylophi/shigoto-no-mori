import { Trees } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SIDEBAR_ICON_BUTTON } from "./sidebarChrome";

// The way into the app-wide tidy page. It lives above the list rather
// than in the footer because what it opens spans every project, the same
// span the list above it has.
//
// Both sidebar views mount one: the projects view puts it in the
// toolbar, the inbox next to its create button. The page is the only
// route with no other entry point, so a view that skipped it would make
// it unreachable for anyone who leaves the sidebar in that view.
export function TidyButton() {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === "/tidy";
  return (
    <SimpleTooltip tip="Tidy the forest: sizes, staleness, what has landed">
      <button
        type="button"
        onClick={() => void navigate({ to: "/tidy" })}
        aria-label="Tidy the forest"
        aria-current={active ? "page" : undefined}
        className={cn(
          SIDEBAR_ICON_BUTTON,
          active && "bg-accent text-foreground",
        )}
      >
        <Trees className="size-3.5" />
      </button>
    </SimpleTooltip>
  );
}
