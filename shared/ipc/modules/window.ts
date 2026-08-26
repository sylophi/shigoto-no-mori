import { z } from "zod";
import { broadcast, defineContract } from "@shared/ipc/contract";

export const windowContract = defineContract("client", {
  focused: broadcast("window:focused", z.void()),
  blurred: broadcast("window:blurred", z.void()),
});
