// The worktree page's footer (WorktreeDetailFooterView), measured so
// its verbs give up their labels on a narrow pane (footerFit.ts).
import { useRef } from "react";
import { AgentSessionsMenu } from "./AgentSessionsMenu";
import { useFittedLabels } from "./footerFit";
import {
  type WorktreeDetailFooterProps,
  WorktreeDetailFooterView,
} from "./WorktreeDetailFooterView";
import { WorktreeOptions } from "./WorktreeOptions";

export function WorktreeDetailFooter({
  options,
  ...props
}: WorktreeDetailFooterProps) {
  const footerRef = useRef<HTMLElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const collapsedThrough = useFittedLabels(footerRef, leadingRef);
  const { worktree, state } = props;
  const busy = state.kind === "normal" && state.busy;
  return (
    <WorktreeDetailFooterView
      {...props}
      footerRef={footerRef}
      leadingRef={leadingRef}
      collapsedThrough={collapsedThrough}
      agents={
        worktree.agentSessions?.length ? (
          <AgentSessionsMenu
            worktree={worktree}
            sessions={worktree.agentSessions}
            busy={busy}
          />
        ) : null
      }
      optionsMenu={
        <WorktreeOptions worktree={worktree} busy={busy}>
          {options}
        </WorktreeOptions>
      }
    />
  );
}
