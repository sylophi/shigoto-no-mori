import { PathSpan } from "@shigomori/ui/primitives/path-span.tsx";
import { DestinationScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

// The landed worktree's path, tildified against the landing machine's
// home: the dialogs sit in the source's scope, hence the re-pin.
export function LandedPath({ path }: { path: string }) {
  return (
    <DestinationScope>
      <TildifiedPath path={path} />
    </DestinationScope>
  );
}

function TildifiedPath({ path }: { path: string }) {
  const { data: runtime } = useRuntimeInfo();
  return (
    <PathSpan
      path={path}
      home={runtime?.homedir ?? null}
      className="min-w-0 truncate font-mono text-xs text-muted-foreground"
      copyable
    />
  );
}
