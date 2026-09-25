import { Trees } from "lucide-react";
import { NavIconButton } from "./NavIconButton";

// The way into the app-wide tidy page. It lives above the list rather
// than in the footer because what it opens spans every project, the same
// span the list above it has.
//
// Both sidebar views mount one: the projects view puts it in the
// toolbar, the inbox next to its create button. The page is the only
// route with no other entry point, so a view that skipped it would make
// it unreachable for anyone who leaves the sidebar in that view.
export function TidyButton() {
  return (
    <NavIconButton
      to="/tidy"
      tip="Tidy the forest: sizes, staleness, what has landed"
      label="Tidy the forest"
    >
      <Trees className="size-3.5" />
    </NavIconButton>
  );
}
