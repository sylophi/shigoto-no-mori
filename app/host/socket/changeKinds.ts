// What a call that changes code is, when a quit should wait on it
// (Engine.changing): its contract's `busy` (packages/contracts
// contract.ts).
import { allContractModules } from "@shigomori/contracts/allModules";
import {
  annotation,
  Busy,
  callsOf,
  channelOf,
} from "@shigomori/contracts/contract";
import type { ChangeKind } from "@shigomori/contracts/modules/session";

const kinds: ReadonlyMap<string, ChangeKind> = new Map(
  allContractModules.flatMap((module) =>
    callsOf(module).flatMap((call) => {
      const kind = annotation(call, Busy);
      return kind === undefined ? [] : [[channelOf(call), kind] as const];
    }),
  ),
);

export const changeKindOf = (channel: string): ChangeKind | undefined =>
  kinds.get(channel);
