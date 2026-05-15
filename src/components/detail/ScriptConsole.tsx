import { useEffect, useRef } from "react";
import Anser, { type AnserJsonEntry } from "anser";
import { ArrowLeft, Play, Square, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { usePackageScripts } from "@/hooks/usePackageScripts";
import { useScriptRunner } from "@/hooks/useScriptRunner";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { useWorktrees } from "@/hooks/useWorktrees";
import { cn } from "@/lib/utils";
import {
  paramToSlot,
  scriptRuns,
  slotLabel,
  type ScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import { scriptConsoleRoute } from "@/router";
import type { Worktree } from "@shared/schemas";
import { ScriptStatusBadge } from "./ScriptStatusBadge";

export function ScriptConsole() {
  const {
    projectId,
    worktreeName,
    scriptKey: rawKey,
  } = scriptConsoleRoute.useParams();
  const navigate = useNavigate();
  const { data: worktrees = [] } = useWorktrees(projectId);
  const worktree = worktrees.find((w) => w.name === worktreeName);
  const slot = paramToSlot(rawKey);

  const goBack = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeName",
      params: { projectId, worktreeName },
    });

  if (!worktree || !slot) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-border px-6 pt-7 pb-4">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden className="size-3" />
            <span>Back</span>
          </button>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Script not found.
        </div>
      </div>
    );
  }

  return <ScriptConsoleInner worktree={worktree} slot={slot} onBack={goBack} />;
}

interface InnerProps {
  worktree: Worktree;
  slot: ScriptSlot;
  onBack: () => void;
}

function ScriptConsoleInner({ worktree, slot, onBack }: InnerProps) {
  const { key, state, busy, start, stop } = useScriptRunner(worktree, slot);
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const { data: pkg } = usePackageScripts(worktree.projectId, worktree.id);

  const command = resolveCommand(slot, config, pkg);
  const label = slotLabel(slot);

  const clear = () => scriptRuns.clear(key);
  const canClear = !busy && state.output.length > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 pt-7 pb-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3" />
          <span>{worktree.branch}</span>
        </button>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="truncate font-mono text-xl font-medium tracking-tight">
              {label}
            </h1>
            {command && (
              <p className="truncate font-mono text-xs text-muted-foreground select-text">
                {command}
              </p>
            )}
            <div className="min-h-[1rem]">
              <ScriptStatusBadge state={state} variant="header" />
            </div>
          </div>
          <div className="shrink-0">
            {busy ? (
              <Button
                variant="outline"
                size="sm"
                onClick={stop}
                disabled={state.cancelling}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Square />
                {state.cancelling ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button size="sm" onClick={start}>
                <Play />
                {state.status === "idle" ? "Run" : "Run again"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <ConsoleBody state={state} onClear={canClear ? clear : null} />
    </div>
  );
}

function ConsoleBody({
  state,
  onClear,
}: {
  state: ScriptRunState;
  onClear: (() => void) | null;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  const tokens = parseOutput(state.output);

  // Honor the user's scroll position: only auto-scroll if they're
  // already pinned near the bottom.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 24;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [tokens]);

  if (state.status === "idle" && tokens.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No runs yet. Press Run to start.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full w-full overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground select-text"
      >
        {tokens.length === 0
          ? "Starting…"
          : tokens.map((tok, i) => (
              // Output is append-only and tokens never reshuffle, so
              // position is a stable identity here.
              // oxlint-disable-next-line react/no-array-index-key
              <AnsiSpan key={i} token={tok} />
            ))}
      </pre>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear log"
          title="Clear log"
          className="absolute top-2 right-3 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// Combine chunks, collapse \r progress-bar overwrites within each line
// (the last segment wins), then parse ANSI/SGR into colored + styled
// tokens. \r-collapse runs before parsing so progress indicators that
// don't change attributes mid-bar still show as one final line.
function parseOutput(chunks: string[]): AnserJsonEntry[] {
  if (chunks.length === 0) return [];
  const collapsed = chunks
    .join("")
    .split("\n")
    .map((line) =>
      line.includes("\r") ? (line.split("\r").pop() ?? line) : line,
    )
    .join("\n");
  return Anser.ansiToJson(collapsed, {
    use_classes: true,
    remove_empty: true,
  });
}

function AnsiSpan({ token }: { token: AnserJsonEntry }) {
  const decorations = token.decorations ?? [];
  const style: React.CSSProperties = {};
  // Anser's JSON emits raw color names in `fg` / `bg`:
  //   - "ansi-red"..."ansi-bright-white" for the 16 base colors;
  //     we need to append "-fg" / "-bg" to hit our CSS classes.
  //   - "ansi-palette-N" for 256-color indices 16-255;
  //     we resolve those to rgb() via the standard xterm palette.
  //   - "ansi-truecolor" for 24-bit; the rgb string is in
  //     fg_truecolor / bg_truecolor.
  let fgClass: string | null = null;
  let bgClass: string | null = null;
  if (token.fg) {
    const inline = resolveAnsiInline(token.fg, token.fg_truecolor);
    if (inline) style.color = inline;
    else fgClass = `${token.fg}-fg`;
  }
  if (token.bg) {
    const inline = resolveAnsiInline(token.bg, token.bg_truecolor);
    if (inline) style.backgroundColor = inline;
    else bgClass = `${token.bg}-bg`;
  }
  const className = cn(
    fgClass,
    bgClass,
    decorations.includes("bold") && "font-semibold",
    decorations.includes("italic") && "italic",
    decorations.includes("underline") && "underline",
    decorations.includes("strikethrough") && "line-through",
    decorations.includes("dim") && "opacity-60",
    decorations.includes("hidden") && "invisible",
  );
  const hasStyle =
    style.color !== undefined || style.backgroundColor !== undefined;
  if (!className && !hasStyle) return token.content;
  return (
    <span className={className} style={hasStyle ? style : undefined}>
      {token.content}
    </span>
  );
}

const PALETTE_RE = /^ansi-palette-(\d+)$/;

function resolveAnsiInline(
  name: string,
  truecolor: string | null,
): string | null {
  if (name === "ansi-truecolor" && truecolor) return `rgb(${truecolor})`;
  const m = PALETTE_RE.exec(name);
  if (!m) return null;
  const idx = Number(m[1]);
  if (idx < 16 || idx > 255) return null;
  return PALETTE_256[idx - 16];
}

// 256-color palette covering indices 16-255 (0-15 hit the named CSS
// classes). 16-231: 6x6x6 cube; 232-255: 24-step grayscale. Standard
// values match what xterm and modern terminal emulators use.
const PALETTE_256: string[] = (() => {
  const cube = [0, 95, 135, 175, 215, 255];
  const out: string[] = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        out.push(`rgb(${cube[r]}, ${cube[g]}, ${cube[b]})`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(`rgb(${v}, ${v}, ${v})`);
  }
  return out;
})();

function resolveCommand(
  slot: ScriptSlot,
  config:
    | { scripts?: { setup?: string; teardown?: string } }
    | null
    | undefined,
  pkg: { scripts: Record<string, string> } | null | undefined,
): string {
  if (slot.kind === "setup") return config?.scripts?.setup ?? "";
  if (slot.kind === "teardown") return config?.scripts?.teardown ?? "";
  return pkg?.scripts[slot.name] ?? "";
}
