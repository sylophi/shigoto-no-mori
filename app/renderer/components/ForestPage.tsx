// The phone layout's forest tabs, "/forest/inbox" and
// "/forest/projects": the sidebar's two views as pages of their own.
// The very same Sidebar component the wide layout keeps beside the
// routed page, minus its footer (the tab bar carries that cluster) and
// with the view pinned by the route (the preference follows it,
// below), so a worktree row reads the same whichever layout draws it.
// On a wide viewport the forest is the sidebar, so the page has
// nothing to show but a pointer to it (ForestPageView). It stays put
// rather than redirecting: a phone turned to landscape crosses the
// breakpoint, and turning back should find the forest where it was.
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { SidebarViewSchema } from "@shigomori/contracts/schemas";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ForestPageView } from "@shigomori/ui/views/ForestPageView.tsx";
import {
  useSetSidebarView,
  useSidebarView,
  useSidebarViewSettled,
} from "@/hooks/projects/useSidebarView";
import { usePhoneLayout } from "@/hooks/ui/useViewport";

const route = getRouteApi("/forest/$view");

export function ForestPage() {
  const phone = usePhoneLayout();
  // A stray param reads as the tree rather than a not-found page.
  const param = route.useParams().view;
  const view = Schema.is(SidebarViewSchema)(param) ? param : "projects";
  // Being on a forest tab is what makes it the preferred view, however
  // the page was reached (a tab tap, the index redirect, a deep link),
  // so the tab bar and the back bar over a stacked page agree with the
  // route rather than with the last tap.
  const preferred = useSidebarView();
  const { mutate: setView } = useSetSidebarView();
  // Written as the route or the layout changes, or as the stored view is
  // first read, not as it moves: a write that failed puts the stored
  // view back, which must not ask for the write again.
  const settled = useSidebarViewSettled();
  const follow = useEffectEvent(() => {
    if (preferred !== view) setView(view);
  });
  useEffect(() => {
    if (phone && settled) follow();
  }, [phone, view, settled]);
  return (
    <ForestPageView
      phone={phone}
      sidebar={<Sidebar footer={false} view={view} />}
    />
  );
}
