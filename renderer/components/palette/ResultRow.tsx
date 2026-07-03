import { Command } from "cmdk";
import { Check, FolderGit2, Square } from "lucide-react";
import { PathSpan } from "@/components/ui/path-span";
import { isWindows } from "@/lib/platform";
import { ensureTrailingSep } from "@/lib/projectPaths";
import { ITEM_CLASS } from "./cmdkClasses";

// Windows scan results come back with native backslashes while the user
// may have typed the root with forward slashes (both are accepted), and
// NTFS is case-insensitive -- fold both before comparing. Slicing by
// length is safe because the folding preserves length.
function foldForCompare(path: string): string {
  return isWindows ? path.replaceAll("\\", "/").toLowerCase() : path;
}

function relativeFromRoot(absolute: string, root: string): string {
  const trimmedRoot = ensureTrailingSep(root);
  return foldForCompare(absolute).startsWith(foldForCompare(trimmedRoot))
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
