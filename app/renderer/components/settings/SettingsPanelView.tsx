import { type ReactNode, useState } from "react";
import { PAGE_BODY } from "@/components/shared/PageShellView";

// Mounts its children on the first visit and keeps them mounted, so a
// form and its state survive a look elsewhere, while what is never
// visited costs nothing: a section's body (SettingsPanel), and a
// peer's form with its config read, a round trip to that machine,
// which waits for the first time its tab is picked.
export function MountOnceVisited({
  visited,
  children,
}: {
  visited: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(visited);
  if (visited && !shown) setShown(true);
  return shown ? children : null;
}

// One section's body: its own scroll region (so each section keeps its
// scroll position) around the width-capped settings column, mounted on
// its first visit and parked with `hidden` afterwards.
export function SettingsPanelView({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div id={id} hidden={!active} className={PAGE_BODY}>
      <MountOnceVisited visited={active}>
        <div className="flex flex-col gap-10">{children}</div>
      </MountOnceVisited>
    </div>
  );
}
