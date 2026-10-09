import { sharingContract } from "@shigomori/contracts/modules/sharing";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import { sharing } from "@host/lib/sharing";
import * as Views from "@host/lib/views";

export const sharingViews: ViewHandlers<
  typeof sharingContract,
  Views.Services
> = {
  watch: () =>
    Views.view(() => sharing.read(), Views.pushed(sharingContract, "changed")),
};

export const sharingHandlers: Handlers<typeof sharingContract> = {
  read: () => sharing.read(),
  set: (on) => sharing.set(on),
};
