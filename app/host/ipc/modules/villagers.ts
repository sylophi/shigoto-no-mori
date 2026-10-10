import { villagersContract } from "@shigomori/contracts/modules/villagers";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import { VillagerData } from "@host/lib/villagers";

const onData = <A, E>(
  f: (data: VillagerData["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(VillagerData, f);

export const villagersHandlers: Handlers<
  typeof villagersContract,
  unknown,
  VillagerData
> = {
  status: () => onData((data) => data.status),
  download: () => onData((data) => data.start),
  cancel: () => onData((data) => data.cancel),
  remove: () => onData((data) => data.remove),
  face: ({ slug }) => onData((data) => data.face(slug)),
  profiles: () => onData((data) => data.profiles),
};
