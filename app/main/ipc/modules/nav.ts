import { navContract } from "@shared/ipc/modules/nav";
import type { Handlers } from "@shared/ipc/types";
import { takeDeepLink } from "../../electron/deepLink";

export const navHandlers: Handlers<typeof navContract> = { takeDeepLink };
