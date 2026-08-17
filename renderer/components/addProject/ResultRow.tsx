import { Command } from "cmdk";
import { Check, FolderGit2, Square } from "lucide-react";
import { PathSpan } from "@/components/ui/path-span";
import { ensureTrailingSep } from "@/lib/projectPaths";
import { ITEM_CLASS } from "./cmdkClasses";

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

export function ResultRow({
  path,
  scanRoot,
  home,
  isSelected,
  onToggle,
}: ResultRowProps) {
  const relative = relativeFromRoot(path, scanRoot);
  // Result == scanRoot leaves `relative` equal to the absolute path; let
  // PathSpan tildify+shorten it. Nested results are already short.
  const showAbsolute = relative === path;
  return (
    <Command.Item
      value={`result:${path}`}
      keywords={[relative]}
      onSelect={onToggle}
      className={ITEM_CLASS}
    >
      {isSelected ? (
        <Check className="size-4 text-foreground" />
      ) : (
        <Square className="size-4 text-muted-foreground/60" />
      )}
      <FolderGit2 className="size-4 text-muted-foreground/80" />
      {showAbsolute ? (
        <PathSpan
          path={path}
          home={home}
          className="min-w-0 flex-1 truncate font-mono"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {relative}
        </span>
      )}
    </Command.Item>
  );
}
