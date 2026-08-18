import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { notifyError } from "@/lib/toast";

// Where the main process writes its rolling log, and a way to get to it
// without being talked through a path. Hidden entirely when logging
// never came up, since there would be nothing to reveal.
export function LogSection() {
  const { data: runtime } = useRuntimeInfo();
  const logFile = runtime?.logFile ?? null;
  const home = runtime?.homedir ?? null;

  if (!logFile) return null;

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Diagnostics</SectionHeading>
      <div className="flex font-mono text-sm select-text">
        <PathSpan
          path={logFile}
          home={home}
          className="min-w-0 flex-1 truncate"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        The app keeps a running log of what it is doing. Attach it when you
        report a bug. It rotates at 1 MB and only the two previous files are
        kept, so it stays small. Credentials are stripped before anything is
        written.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            window.api.shell
              .showItemInFolder(logFile)
              .catch((err) => notifyError("Couldn't reveal the log", err));
          }}
        >
          <FolderOpen />
          Reveal log in Finder
        </Button>
      </div>
    </section>
  );
}
