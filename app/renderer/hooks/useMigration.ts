// The v3 migration as this machine's shell serves it, from what its
// host tells it (packages/contracts/src/modules/migration.ts): read,
// then kept as the shell pushes each change. Null until the host has
// said, once a window went on to the app past it, and on a client with
// no host of its own. Undefined while it is read.
import { callOf } from "@shigomori/contracts/contract";
import { migrationContract } from "@shigomori/contracts/modules/migration";
import type { MigrationProgress } from "@shigomori/contracts/schemas/migration";
import * as Atom from "effect/reactivity/Atom";
import { useHasLocalHost } from "@/lib/localHost";
import { clientAtoms, shellState } from "@/lib/runtime/atoms";
import { useView } from "@/lib/runtime/viewHooks";

const migrationAtom = Atom.keepAlive(
  clientAtoms.atom(
    shellState(migrationContract, {
      read: callOf(migrationContract, "read"),
      push: callOf(migrationContract, "changed"),
    }),
  ),
);

export function useMigration(): MigrationProgress | null | undefined {
  const hasLocalHost = useHasLocalHost();
  const { data } = useView(hasLocalHost ? migrationAtom : null);
  return hasLocalHost ? data : null;
}
