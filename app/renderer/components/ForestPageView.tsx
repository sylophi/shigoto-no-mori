// The forest tabs' page (ForestPage binds it): on a phone, the sidebar
// as a page of its own. The page marker lets doubutsu lift the rail's
// mint off it (doubutsu.css), so the page wears the canvas and its
// leaves like every other room. On a wide viewport the forest is the
// sidebar, so the page has nothing to show but a pointer to it.
import type { ReactNode } from "react";
import { CenteredMessage } from "@/components/ui/centered-message";

export function ForestPageView({
  phone,
  sidebar,
}: {
  phone: boolean;
  sidebar: ReactNode;
}) {
  if (!phone) {
    return <CenteredMessage>Pick a worktree from the sidebar.</CenteredMessage>;
  }
  return (
    <div data-doubutsu-page="forest" className="flex h-full flex-col">
      {sidebar}
    </div>
  );
}
