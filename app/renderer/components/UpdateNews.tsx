import { useEffect, useState } from "react";
import {
  releaseVersionOf,
  updatedFrom,
} from "@shigomori/contracts/releaseVersions";
import { ChangelogDialog } from "@/components/settings/ChangelogDialog";
import { readStored, writeStored } from "@/lib/localStorage";
import { toast } from "@/lib/toast";

// The build this window last ran, so the first launch after an update
// can say so. Per window: the desktop keeps it with its renderer
// storage, and a browser tab with the web client's, which a deploy
// updates.
const LAST_VERSION_KEY = "shigomori.lastVersion";

// Waits out the boot rush, so the news isn't lost among the first
// paint's toasts and page loads.
const NEWS_DELAY_MS = 2_000;
const NEWS_TOAST_MS = 20_000;

const BUILD = releaseVersionOf(__APP_VERSION__);

// Read once per page, the first time asked, so every later ask agrees
// (StrictMode runs the effect twice).
let upgrade: string | null | undefined;
function takeUpgrade(): string | null {
  upgrade ??= updatedFrom(readStored(LAST_VERSION_KEY), BUILD);
  return upgrade;
}

// This build becomes the one to compare the next against. Only once
// its news is out: a window closed before the toast shows keeps it for
// the next launch.
function recordBuild(): void {
  if (BUILD !== "") writeStored(LAST_VERSION_KEY, BUILD);
}

// After an update, a toast naming the new version, and from it the
// changelog of what the update brought. Silent on a first run (there is
// nothing to compare against), on a dev build, and on a downgrade.
// Mounted beside the toaster at boot, in both shells.
export function UpdateNews() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (takeUpgrade() === null) {
      recordBuild();
      return;
    }
    const timer = setTimeout(() => {
      recordBuild();
      toast(`Updated to v${BUILD}`, {
        // One toast however many times this effect runs.
        id: `updated:${BUILD}`,
        duration: NEWS_TOAST_MS,
        action: { label: "What's new", onClick: () => setOpen(true) },
      });
    }, NEWS_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const from = open ? takeUpgrade() : null;
  return from === null ? null : (
    <ChangelogDialog
      installed={__APP_VERSION__}
      staged={null}
      updatedFrom={from}
      onClose={() => setOpen(false)}
    />
  );
}
