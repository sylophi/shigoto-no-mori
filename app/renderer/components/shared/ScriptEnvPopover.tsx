import { Variable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SCRIPT_ENV_DOCS } from "@shared/scriptEnv";

// The SHIGOMORI_* variables every user-written command runs with
// (setup, teardown, `sm run`, custom tools), a click away from the
// heading of each section that takes one (SectionIntro's action)
// rather than spelled out on the page. A plain button, not a chip with
// a chevron, since it shows a reference and picks nothing. Copying a row copies it as a quoted shell reference,
// since every one of those fields is a shell command and the values
// are paths and free text.
export function ScriptEnvPopover() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm">
            <Variable />
            Environment variables
          </Button>
        }
      />
      <PopoverContent align="end" className="w-96 space-y-1.5">
        <p className="px-1.5 pt-1 text-xs text-muted-foreground">
          Scripts and custom tools run in the worktree with these set.
        </p>
        <ul className="space-y-0.5 select-text">
          {SCRIPT_ENV_DOCS.map((row) => (
            <li
              key={row.name}
              className="group/copy flex items-start gap-1 rounded-md px-1.5 py-1 hover:bg-accent/50"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-foreground/80">
                  {row.name}
                </div>
                <div className="text-xs text-muted-foreground">{row.desc}</div>
              </div>
              <CopyButton value={`"$${row.name}"`} label={`Copy ${row.name}`} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
