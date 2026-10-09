// The frame every project page shares (ProjectDevicePage binds it): a
// header over the picked device's body, led by the device tab bar when
// more than one device holds the repo, and the all-devices tab's body
// beside it.
import type { ReactNode } from "react";
import { PageHeaderView } from "@/components/shared/PageHeaderView";
import { TerrierPawView } from "@/components/shared/TerrierPawView";

export function ProjectDevicePageView({
  projectName,
  title,
  parent,
  tabs,
  terrier,
  chip,
  showAllDevices,
  body,
  allDevices,
}: {
  projectName: string;
  title: string;
  // The page this one is a subpage of, linked from the eyebrow after
  // the project's name.
  parent?: { label: string; onOpen: () => void };
  // The device tab bar (DeviceTabBarView), when there is a pick.
  tabs?: ReactNode;
  // A terrier-sourced project is otherwise indistinguishable from a
  // registered one, and the difference shows up in what you can do to
  // it (no remove).
  terrier: boolean;
  // Names the device where there are no tabs to: the chip a peer's
  // project wears (DeviceChip, nothing locally).
  chip?: ReactNode;
  // The all-devices tab is picked: its body shows in place of the
  // device's, which stays mounted, so a form's unsaved edits survive
  // the visit.
  showAllDevices: boolean;
  body: ReactNode;
  allDevices?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeaderView
        eyebrow={
          parent ? (
            <>
              {projectName}
              <span aria-hidden className="mx-1.5 text-muted-foreground/40">
                /
              </span>
              <button
                type="button"
                onClick={parent.onOpen}
                className="-mx-1 rounded px-1 transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-muted/50"
              >
                {parent.label}
              </button>
            </>
          ) : (
            projectName
          )
        }
        title={title}
        tabs={tabs}
        trailing={
          <>
            {terrier && <TerrierPawView className="size-4" />}
            {chip}
          </>
        }
      />
      <div className={showAllDevices ? "hidden" : "contents"}>{body}</div>
      {showAllDevices && allDevices}
    </div>
  );
}
