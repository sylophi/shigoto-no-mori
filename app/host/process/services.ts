// What the host's handlers and views may reach: the services of the
// layer graph (layer.ts) below the wires that serve them, and the
// platform the graph runs on.
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as FileSync from "@host/fileSync/FileSync";
import type * as GithubCli from "@host/lib/githubCli/GithubCli";
import type * as Ports from "@host/lib/Ports";
import type * as OrphanSweep from "@host/lib/scripts/OrphanSweep";
import type * as ScriptRuns from "@host/lib/scripts/pty";
import type * as Sharing from "@host/lib/sharing";
import type * as Moves from "@host/lib/sync/Moves";
import type * as Terminals from "@host/lib/terminals/Terminals";
import type * as Terrier from "@host/lib/terrier";
import type * as BackgroundFetch from "@host/lib/git/backgroundFetch";
import type * as Engine from "@host/lib/engine";
import type * as Views from "@host/lib/views";
import type * as Villagers from "@host/lib/VillagerData";

export type HostServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | FileSync.FileSync
  | GithubCli.GithubCli
  | Views.Services
  | Ports.Ports
  | OrphanSweep.OrphanSweep
  | ScriptRuns.ScriptRuns
  | Sharing.Sharing
  | Moves.Moves
  | Terminals.Terminals
  | Terrier.Terrier
  | Villagers.VillagerData
  | Engine.Services
  | BackgroundFetch.BackgroundFetch;
