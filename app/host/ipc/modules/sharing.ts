import { sharingContract } from "@shigomori/contracts/modules/sharing";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Sharing from "@host/lib/sharing";
import * as Views from "@host/lib/views";

const current = Effect.flatMap(Sharing.Sharing, (it) => it.current);

export const sharingViews: ViewHandlers<
  typeof sharingContract,
  Views.Services | Sharing.Sharing
> = {
  watch: () =>
    Views.view(() => current, Views.pushed(sharingContract, "changed")),
};

export const sharingHandlers: Handlers<
  typeof sharingContract,
  unknown,
  Sharing.Sharing
> = {
  read: () => current,
  set: (on) => Effect.flatMap(Sharing.Sharing, (it) => it.set(on)),
};
