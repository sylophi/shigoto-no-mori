import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";

export const commandPaletteContract = {
  toggle: broadcast("commandPalette:toggle", z.void()),
} as const;

export type CommandPaletteContract = typeof commandPaletteContract;
