import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { broadcast } from "@shared/ipc/contract";

export const paletteContract = {
  toggle: broadcast("palette:toggle", z.void()),
  addProject: broadcast("palette:addProject", z.void()),
} as const;

export type PaletteContract = typeof paletteContract;

const client = buildClient(paletteContract);

export const palette = {
  onToggle: client.toggle,
  onAddProject: client.addProject,
} as const;
