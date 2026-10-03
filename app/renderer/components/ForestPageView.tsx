// The phone layout's forest tab, drawn (ForestPage pins the view and
// keeps the preference in step): the sidebar as a page. The page marker
// lets doubutsu lift the rail's mint off it (doubutsu.css), so the page
// wears the canvas and its leaves like every other room.
import type { ReactNode } from "react";

export function ForestPageView({
  // The sidebar, without its footer (the tab bar carries that cluster).
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div data-doubutsu-page="forest" className="flex h-full flex-col">
      {children}
    </div>
  );
}
