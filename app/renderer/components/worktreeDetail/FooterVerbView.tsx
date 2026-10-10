// A footer verb of the worktree page (footerFit.ts fits them): an icon
// and a label that gives way on a narrow pane, in LABEL_RANK order.
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
} from "react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

// First to lose its label, first. The transfer to start a mirror goes
// first. The verbs whose label carries state (a running mirror's peer,
// an agent at work) or guards a delete go last.
export const LABEL_RANK = {
  mirrorTo: 1,
  files: 2,
  terminal: 3,
  options: 4,
  mirror: 5,
  agents: 6,
  delete: 7,
} as const;

// Every label ranked at or below this is collapsed. 0: none.
const CollapsedThrough = createContext(0);
export const CollapsedThroughProvider = CollapsedThrough.Provider;

// A footer verb: an icon and a label that can collapse. Collapsed, the
// label stays for screen readers (sr-only) and shows as the tooltip,
// ahead of the tip (a longer hint) when there is one. Expanded, the tip
// shows alone. No rank: the label never collapses (an armed delete
// asking for its second click).
export function FooterVerbView({
  rank,
  icon,
  label,
  tip,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  rank: number | undefined;
  icon: ReactNode;
  label: string;
  tip?: string;
}) {
  const through = useContext(CollapsedThrough);
  const collapsed = rank !== undefined && rank <= through;
  const shown = collapsed ? (tip ? `${label}: ${tip}` : label) : tip;
  return (
    <SimpleTooltip tip={shown}>
      <Button size="xs" {...props}>
        {icon}
        <span data-label-rank={rank} className="data-collapsed:sr-only">
          {label}
        </span>
      </Button>
    </SimpleTooltip>
  );
}
