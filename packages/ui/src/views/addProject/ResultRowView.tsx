import { Command } from "cmdk";
import { FolderGit2 } from "lucide-react";
import { Checkbox } from "../../primitives/checkbox.tsx";
import { PathSpan } from "../../primitives/path-span.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { ensureTrailingSep } from "@shigomori/contracts/projectPaths";
import { ITEM_CLASS } from "../../primitives/cmdk-classes.ts";

function relativeFromRoot(absolute: string, root: string): string {
  const trimmedRoot = ensureTrailingSep(root);
  return absolute.startsWith(trimmedRoot)
    ? absolute.slice(trimmedRoot.length)
    : absolute;
}

interface ResultRowProps {
  path: string;
  scanRoot: string;
  home: string | null;
  isSelected: boolean;
  onToggle: () => void;
}

export function ResultRowView({
  path,
  scanRoot,
  home,
  isSelected,
  onToggle,
}: ResultRowProps) {
  const relative = relativeFromRoot(path, scanRoot);
  // Result == scanRoot leaves `relative` equal to the absolute path, which
  // PathSpan tildifies and shortens. Nested results are already short.
  const showAbsolute = relative === path;
  return (
    <Command.Item
      value={`result:${path}`}
      keywords={[relative]}
      onSelect={onToggle}
      className={ITEM_CLASS}
    >
      {/* The row is the control (cmdk's option), so the box only shows
          its state: it takes no click or focus of its own. */}
      <Checkbox
        checked={isSelected}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none"
      />
      <FolderGit2 className="size-4 text-muted-foreground/80" />
      {showAbsolute ? (
        <PathSpan
          path={path}
          home={home}
          className="min-w-0 flex-1 truncate font-mono"
        />
      ) : (
        <SimpleTooltip whenTruncated tip={path}>
          <span className="min-w-0 flex-1 truncate font-mono">{relative}</span>
        </SimpleTooltip>
      )}
    </Command.Item>
  );
}
