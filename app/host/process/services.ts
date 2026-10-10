// What the host's handlers and views may reach: the services of the
// layer graph (layer.ts) below the wires that serve them.
import type * as Ports from "@host/lib/ports";
import type * as Sharing from "@host/lib/sharing";
import type * as Terrier from "@host/lib/terrier";
import type * as Views from "@host/lib/views";
import type * as Villagers from "@host/lib/villagers";

export type HostServices =
  | Views.Services
  | Ports.Ports
  | Sharing.Sharing
  | Terrier.Terrier
  | Villagers.VillagerData;
