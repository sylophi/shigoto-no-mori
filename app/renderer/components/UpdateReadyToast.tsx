import { useEffect, useEffectEvent, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ChangelogDialog } from "@/components/settings/ChangelogDialog";
import { useOnSettingsPages } from "@/components/settings/SettingsSidebarNav";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { WhatsNewLinkView } from "@shigomori/ui/views/WhatsNewLinkView.tsx";
import { useOutdatedDevices, useUpdateAll } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { toast } from "@/lib/toast";
import { useApi } from "@/lib/runtime/pageApi";

// The releases this window has seen news of: the toast closed by hand,
// or the release found while Settings (which shows it) was open. Once
// each, per window.
const seen = new Set<string>();
// The toast as it stands: which of its two forms is up, under which
// id, so its onDismiss can tell a close by hand from this component
// swapping it or taking it down (sonner calls it for both). Each
// showing gets an id of its own, and the last one taken down is
// dismissed again on every pass: sonner adds a toast a beat after it's
// asked to and takes one down a frame after, so a showing and a
// dismissal close together under one id could undo each other.
let shown: { form: "offer" | "updating"; id: string } | null = null;
let gone: string | null = null;
let showings = 0;

// Says so as soon as any device this window could update finds a new
// release, even before it has downloaded it, with the update one click
// away for every device behind (useOutdatedDevices): the ones that
// found it, and the ones whose own check hasn't yet. Under the title, a
// link to what the update brings, in the changelog's preview. Its
// button is Settings' Update all (useUpdateAll): a device with the
// update staged restarts into it, and one without fetches it first and
// restarts once it's staged. It asks for the second click Update all
// does once it would restart another machine. Once taken, it says the
// update is under way until every device behind has restarted, and a
// refusal brings the offer back for a retry. It stays until closed,
// steps aside while its preview is open, never shows on Settings, and
// goes once no device is behind (every device updated, or the release
// pulled).
export function UpdateReadyToast() {
  const localDeviceId = useApi().deviceId;
  const { latest, oldest, outdated } = useOutdatedDevices();
  const { update: updateAll, updating } = useUpdateAll(outdated);
  const { armed, trigger } = useConfirmTwice(CONFIRM_QUICK_MS);
  const [previewOpen, setPreviewOpen] = useState(false);
  const onSettings = useOnSettingsPages();

  const deviceIds = Object.keys(outdated);
  const behind = deviceIds.length > 0;
  const remote = deviceIds.some((deviceId) => deviceId !== localDeviceId);
  // A download an older peer doesn't name counts as one release.
  const release = latest ?? "";
  // Only the release and the offer: which devices it's for, and how far
  // each has got with it, is the button's business.
  const title =
    latest === null ? "An update is available" : `v${latest} is available`;
  const updatingTitle =
    latest === null ? "Updating…" : `Updating to v${latest}…`;
  const label = deviceIds.length === 1 ? "Update" : "Update all";
  const buttonLabel = armed ? "Click again to confirm" : label;

  const update = () => {
    setPreviewOpen(false);
    updateAll();
  };
  // A remote restart asks for the second click Update all does.
  const press = () => (remote ? trigger(update) : update());
  // The toast's button reads this render's closure, not the effect's.
  const pressFromToast = useEffectEvent(press);

  useEffect(() => {
    if (behind && onSettings) seen.add(release);
    const form =
      !behind || previewOpen || seen.has(release)
        ? null
        : updating
          ? "updating"
          : "offer";
    if (form !== (shown?.form ?? null)) {
      if (shown !== null) gone = shown.id;
      showings += 1;
      shown = form === null ? null : { form, id: `updater:${showings}` };
    }
    if (gone !== null) toast.dismiss(gone);
    if (shown === null) return;
    const { id } = shown;
    const onDismiss = () => {
      if (shown?.id === id) seen.add(release);
    };
    if (form === "updating") {
      toast.loading(updatingTitle, {
        id,
        testId: "updater:updating",
        duration: Number.POSITIVE_INFINITY,
        onDismiss,
      });
    } else {
      toast(title, {
        id,
        testId: "updater:ready",
        duration: Number.POSITIVE_INFINITY,
        description:
          latest === null ? undefined : (
            <WhatsNewLinkView onOpen={() => setPreviewOpen(true)} />
          ),
        onDismiss,
        action: {
          label: buttonLabel,
          onClick: (event) => {
            // The toast stays: the first click only arms, and the
            // second swaps it for the update under way.
            event.preventDefault();
            pressFromToast();
          },
        },
      });
    }
  }, [
    behind,
    onSettings,
    previewOpen,
    updating,
    release,
    title,
    updatingTitle,
    latest,
    buttonLabel,
  ]);

  return previewOpen && latest !== null ? (
    <ChangelogDialog
      installed={oldest ?? ""}
      staged={{ version: latest }}
      restartButton={
        <Button
          size="sm"
          disabled={updating}
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
