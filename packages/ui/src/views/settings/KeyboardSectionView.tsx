// Settings' Keyboard section: every action of the keymap with its
// keys, by where it acts (KeyboardSection binds it). A click on the
// keys records the next ones pressed, and a row bound to keys of its
// own can go back to its default.
import { RotateCcw } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import {
  SectionHeading,
  SectionIntro,
} from "../../primitives/section-heading.tsx";
import { TONE_TEXT } from "../../primitives/status-dot.tsx";
import type { KeymapGroup } from "../../lib/keymap.ts";
import { cn } from "../../lib/utils.ts";

export function KeyboardSectionView({
  groups,
  recording,
  refused,
  onRecord,
  onReset,
  onResetAll,
}: {
  groups: readonly KeymapGroup[];
  // The action whose keys are being recorded.
  recording: string | null;
  // Keys just refused for an action, and why.
  refused: { id: string; message: string } | null;
  // Starts recording an action's keys, or stops while it records.
  onRecord: (id: string) => void;
  onReset: (id: string) => void;
  onResetAll: () => void;
}) {
  const anyOwn = groups.some((group) => group.rows.some((row) => row.own));
  return (
    <section className="space-y-6">
      <SectionIntro
        title="Shortcuts"
        action={
          <Button
            variant="ghost"
            size="sm"
            disabled={!anyOwn}
            onClick={onResetAll}
          >
            Reset all
          </Button>
        }
      >
        Click a shortcut, then press the keys you want for it. Esc or a click
        elsewhere cancels.
      </SectionIntro>
      {groups.map((group) => (
        <div key={group.label} className="space-y-1">
          <SectionHeading className="mb-2">{group.label}</SectionHeading>
          {group.rows.map((row) => {
            const isRecording = recording === row.id;
            const message = refused?.id === row.id ? refused.message : null;
            return (
              <div key={row.id} className="py-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {row.label}
                  </span>
                  {row.own && (
                    <IconButton
                      size="xs"
                      aria-label={`Reset ${row.label} to its default`}
                      onClick={() => onReset(row.id)}
                    >
                      <RotateCcw />
                    </IconButton>
                  )}
                  <button
                    type="button"
                    data-recording={isRecording || undefined}
                    aria-label={
                      isRecording
                        ? `Recording keys for ${row.label}`
                        : `Change the keys for ${row.label}, now ${row.keys}`
                    }
                    aria-pressed={isRecording}
                    onClick={() => onRecord(row.id)}
                    className={cn(
                      "inline-flex h-7 min-w-20 shrink-0 items-center justify-center rounded-md bg-muted px-2 font-sans text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                      isRecording &&
                        "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                    )}
                  >
                    {isRecording ? "Press keys…" : row.keys}
                  </button>
                </div>
                {message && (
                  <p
                    role="alert"
                    className={cn("mt-1 text-xs", TONE_TEXT.rose)}
                  >
                    {message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
