// What the host's handlers and views may reach: the services of the
// layer graph (layer.ts) below the wires that serve them.
import type * as Terrier from "@host/lib/terrier";
import type * as Views from "@host/lib/views";

export type HostServices = Views.Services | Terrier.Terrier;
