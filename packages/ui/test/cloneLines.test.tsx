// A move's review when the destination has no checkout of the repo
// (views/worktreeDetail/flow): what the destination answered about the
// folder the clone would take (sync:cloneDestination) is on the review
// before Start.
//   1. A free folder says the repo is cloned first, and Start goes.
//   2. A taken one tints the path beside Change, and the footer says it
//      already exists, with Start held.
//   3. A checkout of the same repo there says the worktree lands in it,
//      and Start goes.
import assert from "node:assert/strict";
import type { SyncCloneDestination } from "@shigomori/contracts/modules/sync";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { LOCAL_DEVICE_ID } from "../src/fixtures/fixtures.ts";
import { projectNamed, worktreeNamed } from "../src/scenes/world.ts";
import {
  CloneLinesView,
  PullReviewFooterView,
} from "../src/views/worktreeDetail/flow/PullReviewView.tsx";
import {
  type CloneDestination,
  cloneRefusal,
} from "../src/views/worktreeDetail/flow/pullSteps.ts";

const noop = () => {};
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const BADGER = worktreeNamed(SM, "brave-badger");

const clone = (found: SyncCloneDestination): CloneDestination => ({
  projectName: SM.name,
  cloneInto: { parentDir: "~/Code/", name: "shigoto-no-mori" },
  dest: "~/Code/shigoto-no-mori",
  found,
  setParent: noop,
});

const review = (found: SyncCloneDestination) => {
  const target = clone(found);
  return {
    lines: renderToStaticMarkup(
      <CloneLinesView
        clone={target}
        title={null}
        worktree={BADGER}
        onChange={noop}
        picker={null}
      />,
    ),
    footer: renderToStaticMarkup(
      <PullReviewFooterView
        refusal={cloneRefusal(target)}
        unpicked={false}
        waiting={false}
        blocked={null}
        idleNote="Nothing leaves this device."
        startLabel="Transplant"
        onCancel={noop}
        onStart={noop}
      />,
    ),
  };
};

const startHeld = (footer: string) =>
  /<button[^>]*disabled=""[^>]*>Transplant/.test(footer);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

it("a free folder is cloned into, and Start goes", () => {
  const { lines, footer } = review("free");
  assert.match(text(lines), /No checkout of shigoto-no-mori there yet/);
  assert.doesNotMatch(lines, /text-amber/);
  assert.equal(startHeld(footer), false);
});

it("a taken folder is tinted and named in the footer, and Start waits", () => {
  const { lines, footer } = review("taken");
  assert.match(lines, /text-amber[^"]*"[^>]*>~\/Code\/shigoto-no-mori/);
  assert.match(text(footer), /~\/Code\/shigoto-no-mori already exists\./);
  assert.equal(startHeld(footer), true);
});

it("a checkout of the same repo there is landed in, and Start goes", () => {
  const { lines, footer } = review("same-repo");
  assert.match(
    text(lines),
    /A checkout of shigoto-no-mori is already there, so the worktree lands in it\./,
  );
  assert.doesNotMatch(lines, /text-amber/);
  assert.equal(startHeld(footer), false);
});
