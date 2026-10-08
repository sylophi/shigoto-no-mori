import { villagersContract } from "@shigomori/contracts/modules/villagers";
import type { Handlers } from "@shigomori/contracts/types";
import { call as onData } from "@host/lib/villagers";

export const villagersHandlers: Handlers<typeof villagersContract> = {
  status: () => onData((data) => data.status),
  download: () => onData((data) => data.start),
  cancel: () => onData((data) => data.cancel),
  remove: () => onData((data) => data.remove),
  face: ({ slug }) => onData((data) => data.face(slug)),
  profiles: () => onData((data) => data.profiles),
};
