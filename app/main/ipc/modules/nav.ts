import { navContract } from "@shigomori/contracts/modules/nav";
import type { Handlers } from "@shigomori/contracts/types";
import { takeDeepLink } from "../../electron/deepLink";

export const navHandlers: Handlers<typeof navContract> = { takeDeepLink };
