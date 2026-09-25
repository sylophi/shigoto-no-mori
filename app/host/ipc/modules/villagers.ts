import { villagersContract } from "@shared/ipc/modules/villagers";
import type { Handlers } from "@shared/ipc/types";
import { villagerData } from "@host/lib/villagers";

export const villagersHandlers: Handlers<typeof villagersContract> = {
  status: () => villagerData().status(),
  download: () => villagerData().start(),
  cancel: () => villagerData().cancel(),
  remove: () => villagerData().remove(),
  face: ({ slug }) => villagerData().face(slug),
  profiles: () => villagerData().profiles(),
};
