// Script slot codec + key builder. Lives here so router params and store
// keys agree on one shape: parsing `/scripts/:scriptKey` (paramToSlot)
// and minting a sidebar/store key (scriptKey) both go through this file.

import { assertNever } from "@/lib/utils";

export type ScriptSlot =
  | { kind: "setup" }
  | { kind: "teardown" }
  | { kind: "portPool"; phase: "provision" | "release" }
  | { kind: "package"; name: string };

export type ScriptKey = string;

export function scriptKey(
  projectId: string,
  worktreeId: string,
  slot: ScriptSlot,
): ScriptKey {
  if (slot.kind === "package") {
    return `${projectId} ${worktreeId} pkg ${slot.name}`;
  }
  if (slot.kind === "portPool") {
    return `${projectId} ${worktreeId} portPool ${slot.phase}`;
  }
  return `${projectId} ${worktreeId} ${slot.kind}`;
}

// URL-safe encoding for router params. `pkg.` prefix + encoded name
// keeps package script names with slashes/dots intact through routing.
export function slotToParam(slot: ScriptSlot): string {
  if (slot.kind === "package") {
    return `pkg.${encodeURIComponent(slot.name)}`;
  }
  if (slot.kind === "portPool") {
    return `port-pool.${slot.phase}`;
  }
  return slot.kind;
}

export function paramToSlot(param: string): ScriptSlot | null {
  if (param === "setup") return { kind: "setup" };
  if (param === "teardown") return { kind: "teardown" };
  if (param === "port-pool.provision") {
    return { kind: "portPool", phase: "provision" };
  }
  if (param === "port-pool.release") {
    return { kind: "portPool", phase: "release" };
  }
  if (param.startsWith("pkg.")) {
    try {
      return { kind: "package", name: decodeURIComponent(param.slice(4)) };
    } catch {
      return null;
    }
  }
  return null;
}

export function slotLabel(slot: ScriptSlot): string {
  switch (slot.kind) {
    case "setup":
      return "Setup";
    case "teardown":
      return "Teardown";
    case "portPool":
      return slot.phase === "provision"
        ? "Port-pool provision"
        : "Port-pool release";
    case "package":
      return slot.name;
    default:
      return assertNever(slot);
  }
}
