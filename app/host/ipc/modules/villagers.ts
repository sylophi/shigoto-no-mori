import { villagersContract } from "@shigomori/contracts/modules/villagers";
import type { Handlers } from "@shigomori/contracts/types";
import { villagerData } from "@host/lib/villagers";

export const villagersHandlers: Handlers<typeof villagersContract> = {
  status: () => villagerData().status(),
  download: () => villagerData().start(),
  cancel: () => villagerData().cancel(),
  remove: () => villagerData().remove(),
  face: ({ slug }) => villagerData().face(slug),
  profiles: () => villagerData().profiles(),
};
