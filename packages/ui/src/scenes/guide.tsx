// The guide: the band while an agent drives a window, and its ring and
// sentence on what it points at.
import type { ReactNode } from "react";
import { Button } from "../primitives/button.tsx";
import { GuideBandView, GuideCalloutView } from "../views/guide/GuideView.tsx";

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

const noop = () => {};

export function GuidePartsScene() {
  return (
    <div className="flex h-full flex-col gap-6 overflow-hidden bg-background p-6 text-foreground">
      <Part label="The band over the page">
        <div className="overflow-hidden rounded-lg bg-card">
          <GuideBandView harnessLabel="Claude Code" onStop={noop} />
          <div className="h-10" />
        </div>
      </Part>
      <Part label="Pointing, with room under the target">
        <div className="relative h-44 overflow-hidden rounded-lg bg-card">
          <div className="absolute top-6 left-6 flex gap-2">
            <Button size="sm" variant="outline">
              Transplant
            </Button>
            <Button size="sm" variant="outline">
              Mirror
            </Button>
          </div>
          <GuideCalloutView
            place={{
              radius: "9999px",
              ring: { x: 115, y: 24, width: 57, height: 28 },
              left: 115,
              top: 64,
            }}
            say="Mirror keeps this worktree in step with a copy on another device."
          />
        </div>
      </Part>
      <Part label="Pointing, with room over it">
        <div className="relative h-44 overflow-hidden rounded-lg bg-card">
          <div className="absolute bottom-6 left-6">
            <Button size="sm">Save</Button>
          </div>
          <GuideCalloutView
            place={{
              radius: "9999px",
              ring: { x: 24, y: 124, width: 50, height: 28 },
              left: 24,
              bottom: 64,
            }}
            say="Save keeps the new terminal key."
          />
        </div>
      </Part>
    </div>
  );
}
