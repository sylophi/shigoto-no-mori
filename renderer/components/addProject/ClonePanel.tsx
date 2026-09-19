import { FolderInput, GitBranch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";

// The body of the add-project dialog while its input holds a remote
// URL instead of a path: what will be cloned, and where it will land.
// The folder opens on where this device already keeps its repos
// (cloneDestination.ts), so the common case is one keypress.
export function CloneDestination({
  repo,
  dest,
  home,
  deviceLabel,
  onChangeParent,
}: {
  // The remote as repo identity spells it (host/owner/repo): the
  // credentials and scheme of the pasted URL are noise here.
  repo: string;
  dest: string;
  home: string | null;
  // The peer doing the clone. Undefined on this device.
  deviceLabel: string | undefined;
  onChangeParent: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      <div className="flex items-center gap-2.5">
        <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
        <span className="min-w-0 flex-1 truncate font-mono">{repo}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <FolderInput className="size-4 shrink-0 text-muted-foreground/80" />
        <PathSpan
          path={dest}
          home={home}
          className="min-w-0 flex-1 truncate font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onChangeParent}
        >
          Change folder
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {deviceLabel
          ? `${deviceLabel} clones it with its own git credentials, then adds it as a project.`
          : "Cloned with this device's git credentials, then added as a project."}
      </p>
    </div>
  );
}

// No cancel: a clone can't be called back once the device has started
// it. Closing the dialog leaves it running, and the project shows up in
// the sidebar when it lands.
export function CloningPanel({
  repo,
  dest,
  deviceLabel,
}: {
  repo: string;
  // Already tildified by the dialog.
  dest: string;
  deviceLabel: string | undefined;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <GitBranch className="size-4 shrink-0 text-muted-foreground/80" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {repo}
        </span>
      </div>
      <div className="flex flex-col items-center gap-3 px-4 py-14 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
        <span>{deviceLabel ? `Cloning on ${deviceLabel}…` : "Cloning…"}</span>
        {/* Spelled whole: PathSpan shortens to its box, and a centered
            line has none to measure. */}
        <span className="font-mono text-xs">{dest}</span>
      </div>
      <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground/80">
        A big repository takes a while. Closing this leaves the clone running.
      </div>
    </div>
  );
}
