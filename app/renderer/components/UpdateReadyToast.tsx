import { useEffect, useEffectEvent, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { ChangelogDialog } from "@/components/settings/ChangelogDialog";
import { Button } from "@/components/ui/button";
import { useOutdatedDevices, useUpdateAll } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { localDeviceId } from "@/lib/queryKeys";
import { toast } from "@/lib/toast";

const TOAST_ID = "updater:ready";

// The releases this window has seen news of: the toast closed by hand,
// its update taken, or the release found while Settings (which shows
// it) was open. Once each, per window.
const seen = new Set<string>();
// Whether the toast is meant to be up, so its onDismiss can tell a
// close by hand from this component taking it down (sonner calls it
// for both).
let wanted = false;

// Says so as soon as any device this window could update finds a new
// release, even before it has downloaded it, with the update one click
// away for every device behind (useOutdatedDevices): the ones that
// found it, and the ones whose own check hasn't yet. Under the title, a
// link to what the update brings, in the changelog's preview. Its
// button is Settings' Update all (useUpdateAll): a device with the
// update staged restarts into it, and one without fetches it first and
// restarts once it's staged. It asks for the second click Update all
// does once it would restart another machine. It stays until closed or
// used, steps aside while its preview is open, never shows on Settings,
// and goes once no device is behind (every device updated, or the
// release pulled).
export function UpdateReadyToast() {
  const { latest, oldest, outdated } = useOutdatedDevices();
  const { mutate: updateAll, isPending: updating } = useUpdateAll(outdated);
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const [previewOpen, setPreviewOpen] = useState(false);
  const onSettings = useLocation({
    select: (location) => location.pathname === "/settings",
  });

  const deviceIds = Object.keys(outdated);
  const behind = deviceIds.length > 0;
  const remote = deviceIds.some((deviceId) => deviceId !== localDeviceId);
  // A download an older peer doesn't name counts as one release.
  const release = latest ?? "";
  // Only the release and the offer: which devices it's for, and how far
  // each has got with it, is the button's business.
  const title =
    latest === null ? "An update is available" : `v${latest} is available`;
  const label = deviceIds.length === 1 ? "Update" : "Update all";
  const buttonLabel = armed ? "Click again to confirm" : label;

  // Seen once it's taken: a refusal brings the toast back for a retry.
  // The toast is down meanwhile, taken down here rather than closed.
  const update = () => {
    wanted = false;
    setPreviewOpen(false);
    updateAll(undefined, { onSuccess: () => seen.add(release) });
  };
  // A remote restart asks for the second click Update all does.
  const press = () => (remote ? trigger(update) : update());
  // The toast's button reads this render's closure, not the effect's.
  const pressFromToast = useEffectEvent(press);

  useEffect(() => {
    if (behind && onSettings) seen.add(release);
    wanted = behind && !previewOpen && !updating && !seen.has(release);
    if (!wanted) {
      toast.dismiss(TOAST_ID);
      return;
    }
    toast(title, {
      id: TOAST_ID,
      testId: TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      description:
        latest === null ? undefined : (
          <button
            type="button"
            data-no-hit-area
            onClick={() => setPreviewOpen(true)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            What&apos;s new
          </button>
        ),
      onDismiss: () => {
        if (wanted) seen.add(release);
      },
      action: {
        label: buttonLabel,
        onClick: (event) => {
          // The first click only arms, so the toast stays for the
          // second.
          if (remote && !armed) event.preventDefault();
          pressFromToast();
        },
      },
    });
  }, [
    behind,
    onSettings,
    previewOpen,
    updating,
    release,
    title,
    latest,
    buttonLabel,
    remote,
    armed,
  ]);

  return previewOpen && latest !== null ? (
    <ChangelogDialog
      installed={oldest ?? ""}
      staged={{ version: latest }}
      restartButton={
        <Button
          size="sm"
          aria-pressed={remote ? armed : undefined}
          onClick={press}
        >
          <RefreshCw />
          {buttonLabel}
        </Button>
      }
      onClose={() => setPreviewOpen(false)}
    />
  ) : null;
}
