import type { ReactNode } from "react";
import { Button } from "../../primitives/button.tsx";
import { ErrorBanner } from "../../primitives/error-banner.tsx";
import type { RowStatus } from "../../primitives/row-status.tsx";
import type { DeviceLayout } from "./layoutOptions.ts";
import type {
  Worktree,
  WorktreeLayout,
} from "@shigomori/contracts/schemas/index";
import { pluralize } from "../../lib/pluralize.ts";
import { LayoutOptionItemView } from "./LayoutOptionItemView.tsx";
import { LAYOUT_OPTIONS } from "./layoutOptions.ts";
import { WorktreeMoveDetailsView } from "../shared/WorktreeMoveDetailsView.tsx";
import { tildify } from "@shigomori/contracts/projectPaths";

// The project's worktree layout, picked, and the worktrees the pick
// moves (LocationForm.tsx saves it and runs the moves).
export function LocationFormView({
  layout,
  onLayout,
  projectPath,
  device,
  customPath,
  customPathError,
  onOpenPicker,
  toMove,
  status,
  saveError,
  canSubmit,
  batchRunning,
  submitLabel,
  onBack,
  onApply,
  picker,
}: {
  layout: WorktreeLayout;
  onLayout: (layout: WorktreeLayout) => void;
  projectPath: string;
  device: DeviceLayout;
  customPath: string;
  customPathError: string | null;
  onOpenPicker: () => void;
  // The worktrees the layout moves, and where each goes.
  toMove: readonly { worktree: Worktree; destination: string }[];
  // Each move's state in the run, by worktree id.
  status: ReadonlyMap<string, RowStatus>;
  saveError: string | null;
  canSubmit: boolean;
  batchRunning: boolean;
  submitLabel: string;
  onBack: () => void;
  onApply: () => void;
  // The custom folder's picker, while it is open.
  picker: ReactNode;
}) {
  const home = device.homedir;
  return (
    <>
      <fieldset className="space-y-2" disabled={batchRunning}>
        <legend className="sr-only">Worktree location</legend>
        {LAYOUT_OPTIONS.map((opt) => (
          <LayoutOptionItemView
            key={opt.value}
            option={opt}
            checked={layout === opt.value}
            projectPath={projectPath}
            device={device}
            customPath={customPath}
            customPathError={customPathError}
            onSelect={onLayout}
            onOpenPicker={onOpenPicker}
          />
        ))}
      </fieldset>

      {toMove.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 select-text dark:text-amber-300">
          <p className="text-2xs font-semibold tracking-wide uppercase">
            Heads up
          </p>
          <p className="mt-2 leading-relaxed">
            {`${pluralize(toMove.length, "worktree")} will move to the new location. `}
            Uncommitted changes and untracked files are preserved. Repoint any
            open editors, terminals, or IDE projects to the new paths.
          </p>
        </div>
      )}

      {toMove.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {toMove.map(({ worktree: wt, destination }) => {
            return (
              <div
                key={wt.id}
                className="flex items-start gap-3 px-3 py-3 text-sm"
              >
                <WorktreeMoveDetailsView
                  branch={wt.branch}
                  detached={wt.detached}
                  fromPath={tildify(wt.path, home)}
                  fromTip={wt.path}
                  toPath={tildify(destination, home)}
                  toTip={destination}
                  status={status.get(wt.id) ?? { kind: "idle" }}
                  labels={{
                    running: "Moving",
                    done: "Moved",
                    error: "Move failed",
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {saveError !== null && (
        <ErrorBanner
          message={saveError}
          title="Couldn't save the worktree location"
        />
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={batchRunning}
        >
          {canSubmit ? "Cancel" : "Back"}
        </Button>
        <Button type="button" size="sm" onClick={onApply} disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </div>

      {picker}
    </>
  );
}
