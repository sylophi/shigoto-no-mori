import * as Effect from "effect/Effect";
import { villagersContract } from "@shigomori/contracts/modules/villagers";
import type { Handlers } from "@shigomori/contracts/types";
import { run, VillagerData } from "@host/lib/villagers";

const onData = <A>(f: (data: VillagerData["Service"]) => Effect.Effect<A>) =>
  run(
    Effect.gen(function* () {
      return yield* f(yield* VillagerData);
    }),
  );

export const villagersHandlers: Handlers<typeof villagersContract> = {
  status: () => onData((data) => data.status),
  download: () => onData((data) => data.start),
  cancel: () => onData((data) => data.cancel),
  remove: () => onData((data) => data.remove),
  face: ({ slug }) => onData((data) => data.face(slug)),
  profiles: () => onData((data) => data.profiles),
};
