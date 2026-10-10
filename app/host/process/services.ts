// What the host's handlers and views may reach: the services of the
// layer graph (layer.ts) below the wires that serve them, and the
// platform the graph runs on.
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as GithubCli from "@host/lib/githubCli/GithubCli";
import type * as Ports from "@host/lib/ports";
import type * as Sharing from "@host/lib/sharing";
import type * as Terminals from "@host/lib/terminals/Terminals";
import type * as Terrier from "@host/lib/terrier";
import type * as Views from "@host/lib/views";
import type * as Villagers from "@host/lib/villagers";

export type HostServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | GithubCli.GithubCli
  | Views.Services
  | Ports.Ports
  | Sharing.Sharing
  | Terminals.Terminals
  | Terrier.Terrier
  | Villagers.VillagerData;
