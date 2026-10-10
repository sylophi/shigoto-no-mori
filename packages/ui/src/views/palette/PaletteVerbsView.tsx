import type { ComponentType, ReactNode, SVGProps } from "react";
import { Play } from "lucide-react";
import { Kbd } from "../../primitives/kbd.tsx";
import { rankByScore } from "../../lib/fuzzyMatch.ts";
import { cn } from "../../lib/utils.ts";
import {
  PaletteGroupView,
  PaletteItemView,
  usePaneHasKeys,
} from "./PaletteItemView.tsx";

// The highlighted row's verbs, drawn (PaletteVerbs.tsx says which a
// row has and what each runs).

export interface Verb {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  // The key that runs it wherever the keys are (a tool's ⌘ digit).
  keys?: string;
  // The key that runs it from the list (↩, ⌘↩), not shown once the
  // pane has the keys and ↩ runs whichever verb is highlighted.
  listKeys?: string;
  // What the query matches, when not the label.
  search?: string;
  disabled?: boolean;
  tip?: string;
}

const ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground/80";
export const iconOf = (Icon: ComponentType<SVGProps<SVGSVGElement>>) => (
  <Icon className={ICON_CLASS} />
);

// A group of verbs, filtered by the query the way the worktree list
// is, each group on its own so the groups keep their places.
export function VerbGroupView({
  heading,
  query,
  verbs,
}: {
  heading: string;
  query: string;
  verbs: readonly Verb[];
}) {
  const hasKeys = usePaneHasKeys();
  const shown = rankByScore(query, verbs, (verb) => verb.search ?? verb.label);
  if (shown.length === 0) return null;
  return (
    <PaletteGroupView heading={heading}>
      {shown.map((verb) => {
        const keys = verb.keys ?? (hasKeys ? undefined : verb.listKeys);
        return (
          <PaletteItemView
            key={verb.key}
            value={verb.key}
            onSelect={verb.run}
            disabled={verb.disabled}
            tip={verb.tip}
            className="text-xs"
          >
            {verb.icon}
            <span className="min-w-0 flex-1 truncate">{verb.label}</span>
            {keys && <Kbd className="ml-auto shrink-0">{keys}</Kbd>}
          </PaletteItemView>
        );
      })}
    </PaletteGroupView>
  );
}

// Runs the script and lands on its console, so the output is what you
// see next. One already running just opens the console.
export function ScriptVerbView({
  name,
  command,
  busy,
  disabled,
  tip,
  onSelect,
}: {
  name: string;
  command: string;
  // Running already: the row opens its console.
  busy: boolean;
  disabled: boolean;
  tip: string;
  onSelect: () => void;
}) {
  return (
    <PaletteItemView
      className="text-xs"
      value={`script:${name}`}
      disabled={disabled}
      onSelect={onSelect}
      tip={tip}
    >
      <Play className={ICON_CLASS} />
      <span className="shrink-0 font-mono">{name}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-right font-mono text-2xs text-muted-foreground",
          busy && "text-emerald-500",
        )}
      >
        {busy ? "running" : command}
      </span>
    </PaletteItemView>
  );
}
