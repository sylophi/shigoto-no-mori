// The frame a multi-step worktree dialog wears: the header, the step
// rail, the scroll body, the footer band and the card styles. The
// transplant and the mirror (../transplant/, ../mirror/) walk all of it
// through PullFlow.tsx, and the ports dialog and Settings' health check
// borrow the header, body and footer.
import { PathSpan } from "@/components/ui/path-span";
import { DestinationScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";

// The views themselves (FlowChromeView.tsx), here for the dialogs that
// take them from this module.
export {
  CARD,
  CARD_NOTE,
  CardList,
  CardSkeleton,
  FlowBody,
  FlowFooter,
  FlowHeader,
  MAX_LIST_ROWS,
  StepRail,
} from "./FlowChromeView";

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
