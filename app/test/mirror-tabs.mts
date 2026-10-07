// Durable proof for a mirrored worktree's tabs (mirrorSideTabs in
// renderer/components/worktreeDetail/mirror/mirrorSides.ts).
//
// Asserts: the original's page and the copy's page name the same sides
// in the same order, the original first and the arrow before the copy,
// and only the other side's tab carries where its page is. Devices off
// the mirror get no tab. No tabs without another side to pick: no
// mirror, or one known only from a served stream (no project to open).
//
// Run: pnpm test mirror-tabs.
import assert from "node:assert/strict";
import type { DeviceRosterEntry } from "@/components/shared/DeviceTabs";
import {
  mirrorSideTabs,
  type MirrorSideTab,
} from "@/components/worktreeDetail/mirror/mirrorSides";
import { it } from "vitest";

const device = (deviceId: string): DeviceRosterEntry => ({
  deviceId,
  label: deviceId,
  icon: "laptop",
  isThisDevice: deviceId === "mac",
  status: null,
  api: undefined,
});
// This device first, as the roster has it, and a peer off the mirror.
const roster = ["mac", "thinkpad", "mini"].map(device);

const onMac = { projectId: "p-mac", worktreeId: "wt-mac" };
const onThinkpad = { projectId: "p-tp", worktreeId: "wt-tp" };

const line = (tabs: MirrorSideTab[] | null) =>
  tabs?.map(
    (tab) =>
      `${tab.arrowBefore ? "-> " : ""}${tab.deviceId} ${tab.note}${
        tab.at ? ` @${tab.at.worktreeId}` : ""
      }`,
  ) ?? null;

it("on the original: it first, then its copy", () => {
  // The Thinkpad runs the session: it holds the original.
  const tabs = mirrorSideTabs(
    [
      {
        runnerDeviceId: "thinkpad",
        otherDeviceId: "mac",
        otherCopy: onMac,
      },
    ],
    "thinkpad",
    roster,
  );
  assert.deepEqual(line(tabs), ["thinkpad original", "-> mac copy @wt-mac"]);
});

it("on the copy: the same sides, the same order", () => {
  // The page's device is not the runner: it holds the copy.
  const tabs = mirrorSideTabs(
    [
      {
        runnerDeviceId: "thinkpad",
        otherDeviceId: "thinkpad",
        otherCopy: onThinkpad,
      },
    ],
    "mac",
    roster,
  );
  assert.deepEqual(line(tabs), ["thinkpad original @wt-tp", "-> mac copy"]);
});

it("no other side to pick, no tabs", () => {
  assert.equal(mirrorSideTabs([], "mac", roster), null);
  // A served stream alone names no project for the other side.
  assert.equal(
    mirrorSideTabs(
      [
        {
          runnerDeviceId: "thinkpad",
          otherDeviceId: "thinkpad",
          otherCopy: undefined,
        },
      ],
      "mac",
      roster,
    ),
    null,
  );
});
