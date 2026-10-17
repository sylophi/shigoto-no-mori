// What the host's handlers and views may reach: the services of the
// layer graph (layer.ts) below the wires that serve them, and the
// platform the graph runs on.
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as FileSync from "@host/fileSync/FileSync";
import type * as CliShell from "@host/lib/cli/shell";
import type * as GithubCli from "@host/lib/githubCli/GithubCli";
import type * as Ports from "@host/lib/Ports";
import type * as OrphanSweep from "@host/lib/scripts/OrphanSweep";
import type * as ScriptRuns from "@host/lib/scripts/ScriptRuns";
import type * as ScriptChanges from "@host/lib/scripts/ScriptChanges";
import type * as Sharing from "@host/lib/Sharing";
import type * as Moves from "@host/lib/sync/Moves";
import type * as Terminals from "@host/lib/terminals/Terminals";
import type * as BackgroundFetch from "@host/lib/BackgroundFetch";
import type * as Engine from "@host/lib/Engine";
import type * as Views from "@host/lib/Views";
import type * as Villagers from "@host/lib/VillagerData";
import type * as Worktrees from "@host/lib/Worktrees";
import type * as AccountPeers from "@host/lib/control/AccountPeers";
import type * as DeviceId from "@host/lib/config/DeviceId";
import type * as DataDirHolders from "@host/lib/DataDirHolders";
import type * as HostFacts from "@host/lib/HostFacts";
import type * as Shell from "@host/lib/Shell";
import type * as PeerReach from "@host/ipc/PeerReach";
import type * as MirrorEngine from "@host/mirror/MirrorEngine";
import type * as MirrorSignals from "@host/mirror/MirrorSignals";
import type * as PortForwards from "@host/portForward/PortForwards";

export type HostServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | FileSync.FileSync
  | GithubCli.GithubCli
  | CliShell.HookShell
  | Views.Services
  | Ports.Ports
  | OrphanSweep.OrphanSweep
  | ScriptRuns.ScriptRuns
  | ScriptChanges.ScriptChanges
  | Sharing.Sharing
  | Moves.Moves
  | Terminals.Terminals
  | Villagers.VillagerData
  | Worktrees.Worktrees
  | Engine.Services
  | BackgroundFetch.BackgroundFetch
  | HostFacts.HostFacts
  | Shell.Shell
  | DeviceId.DeviceId
  | PeerReach.PeerReach
  | AccountPeers.AccountPeers
  | MirrorEngine.MirrorEngine
  | MirrorSignals.MirrorSignals
  | PortForwards.PortForwards
  | DataDirHolders.DataDirHolders;
