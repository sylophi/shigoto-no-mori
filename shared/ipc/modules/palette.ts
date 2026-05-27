import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";

export const paletteContract = {
  toggle: broadcast("palette:toggle", z.void()),
  addProject: broadcast("palette:addProject", z.void()),
} as const;

export type PaletteContract = typeof paletteContract;
