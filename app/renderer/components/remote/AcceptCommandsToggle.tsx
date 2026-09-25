// "Allow control from other devices": whether THIS machine runs the
// commands the account's other devices send it. The decision sits on the
// machine being driven, in its own registry row, because that is the
// machine whose owner is exposing something. There is nothing to
// configure per peer: every device on the account is the same
// person's, so the only question is whether this one takes orders at
// all. Off, the machine is still browsable from everywhere, since
// reads were never gated.
//
// It is the loudest switch in the app (a peer holding it can edit the
// setup script and then run it, which is any command as the user, over
// the tunnel from anywhere), so its row sits in a panel of its own that
// spells out what the grant covers and tints while it is on.
//
// The GRANTS list is the `remote: true, mutating: true` host channels
// in shared/ipc/modules, grouped the way a person weighs them. A new
// gated channel that does not fit a line here needs a line.
//
// Written immediately through the host store, never staged in a form:
// flipping it is the whole action. The registry mounts the watcher
// that follows a flip made in another window.
import {
  Cable,
  Eye,
  FolderSearch,
  GitBranch,
  Settings2,
  ShieldAlert,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { ToggleRow } from "@/components/shared/ToggleRow";
import { TONE_PILL, TONE_TEXT } from "@/components/ui/status-dot";
import {
  useAcceptsCommands,
  useSetAcceptsCommands,
} from "@/hooks/account/useAccount";
import { cn } from "@/lib/utils";

const GRANTS: readonly { icon: LucideIcon; title: string; detail: string }[] = [
  {
    icon: SquareTerminal,
    title: "Run commands as you",
    detail:
      "Edit and run setup, teardown and package.json scripts, and type into their terminals.",
  },
  {
    icon: GitBranch,
    title: "Change your code",
    detail:
      "Create, delete and move worktrees, commit, discard changes, push (force push too) and merge pull requests with this machine's Git and GitHub credentials.",
  },
  {
    icon: FolderSearch,
    title: "Browse your files",
    detail:
      "List folders anywhere on this machine, and add or clone projects into it.",
  },
  {
    icon: Cable,
    title: "Reach local servers",
    detail: "Forward ports to anything listening on this machine's localhost.",
  },
  {
    icon: Settings2,
    title: "Change the app",
    detail:
      "Edit settings, install the CLI and shell hooks, install updates and move the data folder.",
  },
];

// What the panel says about the switch's current state. Unknown (the
// read is in flight or failed) claims nothing: the switch reads off
// then, and calling the machine read-only on that basis could be false.
const STATE_COPY = {
  on: {
    description:
      "Every device signed in to your account can act on this machine as you, from anywhere.",
    heading: "Other devices can now",
  },
  off: {
    description:
      "Your other devices can see this machine but can't change anything on it.",
    heading: "Turning this on lets them",
  },
  unknown: {
    description:
      "Lets every device signed in to your account act on this machine as you, from anywhere.",
    heading: "When on, other devices can",
  },
} as const;

export function AcceptCommandsToggle() {
  const { data: enabled, isError } = useAcceptsCommands();
  const setAcceptsCommands = useSetAcceptsCommands();
  const on = enabled === true;
  const state = enabled === undefined ? "unknown" : on ? "on" : "off";

  return (
    <section
      data-slot="accept-commands-panel"
      className={cn(
        // Filled as well as outlined: doubutsu strips borders and lets
        // the fill carry the panel.
        "flex flex-col gap-3 rounded-md border p-3 transition-colors",
        on
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-border bg-muted/40",
      )}
    >
      <ToggleRow
        checked={on}
        onCheckedChange={(next) => setAcceptsCommands.mutate(next)}
        // Inert until the first read lands, so the switch never shows a
        // false "off" that a click would then turn into a real write. A
        // read that FAILED is a different case: the switch stays live,
        // reading off, so a click is the retry (a successful write fans
        // out and the read runs again).
        disabled={
          (enabled === undefined && !isError) || setAcceptsCommands.isPending
        }
        switchClassName="data-[checked]:bg-amber-500"
        label={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Allow control from other devices
            {state !== "unknown" && <AccessBadge on={on} />}
          </span>
        }
        description={STATE_COPY[state].description}
      />

      <div className="flex flex-col gap-2 pl-11">
        <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {STATE_COPY[state].heading}
        </p>
        <ul className="flex flex-col gap-2">
          {GRANTS.map(({ icon: Icon, title, detail }) => (
            <li key={title} className="flex items-start gap-2.5">
              <Icon
                aria-hidden
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  TONE_TEXT[on ? "amber" : "slate"],
                )}
              />
              <p className="min-w-0 text-xs">
                <span className="font-medium">{title}.</span>{" "}
                <span className="text-muted-foreground">{detail}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function AccessBadge({ on }: { on: boolean }) {
  const Icon = on ? ShieldAlert : Eye;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium",
        TONE_PILL[on ? "amber" : "slate"],
      )}
    >
      <Icon aria-hidden className="size-3" />
      {on ? "Full control" : "Read-only"}
    </span>
  );
}
