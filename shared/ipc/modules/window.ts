import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";

export const windowContract = {
  focused: broadcast("window:focused", z.void()),
  blurred: broadcast("window:blurred", z.void()),
} as const;

export type WindowContract = typeof windowContract;
