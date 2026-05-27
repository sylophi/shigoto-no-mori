import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { broadcast } from "@shared/ipc/contract";

export const windowContract = {
  focused: broadcast("window:focused", z.void()),
  blurred: broadcast("window:blurred", z.void()),
} as const;

export type WindowContract = typeof windowContract;

const client = buildClient(windowContract);

export const windowApi = {
  onFocused: client.focused,
  onBlurred: client.blurred,
} as const;
