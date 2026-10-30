// The host's services, up the way the app's graph (host/process/layer.ts)
// brings them up, so host code a proof or a bench reaches answers
// instead of waiting for a graph that never comes (EFFECT.md, runtime
// boundaries). Every proof's file starts and disposes it (hostSetup.mts);
// a bench under plain node disposes it itself.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { childDefaults } from "@shigomori/engine/processes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migration from "@shigomori/engine/Migration";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FileSync from "../../host/fileSync/FileSync.ts";
import * as Engine from "../../host/lib/Engine.ts";
import * as BackgroundFetch from "../../host/lib/BackgroundFetch.ts";
import * as CliShell from "../../host/lib/cli/shell.ts";
import * as GithubCli from "../../host/lib/githubCli/GithubCli.ts";
import * as PullRequestMaps from "../../host/lib/githubCli/PullRequestMaps.ts";
import * as Scripts from "../../host/lib/Scripts.ts";
import * as ScriptRuns from "../../host/lib/scripts/ScriptRuns.ts";
import * as ScriptChanges from "../../host/lib/scripts/ScriptChanges.ts";
import * as Terminals from "../../host/lib/terminals/Terminals.ts";
import * as HostAccount from "../../host/lib/HostAccount.ts";
import * as Sharing from "../../host/lib/Sharing.ts";
import * as Moves from "../../host/lib/sync/Moves.ts";
import * as OrphanSweep from "../../host/lib/scripts/OrphanSweep.ts";
import * as Views from "../../host/lib/Views.ts";
import { mirrorsOnDelete } from "../../host/mirror/onDelete.ts";
import * as SharedSettingsStore from "../../host/lib/sharedSettings/store.ts";
import * as EngineStoreChanges from "@shigomori/engine/StoreChanges";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
import * as Ports from "../../host/lib/Ports.ts";
import { sandboxEngine } from "./sandboxEngine.mts";
import * as Villagers from "../../host/lib/VillagerData.ts";
import * as Worktrees from "../../host/lib/Worktrees.ts";
import { terminalStart, terminalWorktrees } from "../../host/ipc/scriptRun.ts";
import * as HostStandIns from "./hostStandIns.mts";
import { nativefs } from "../../../packages/engine/test/lib/nativefs.ts";

// The engine's data dir for this file's proofs, a fresh one each file.
// A proof that drives the host's engine calls points the host's own
// data dir (initDataDirAt) at it too.
export const engineDataDir = join(
  realpathSync(mkdtempSync(join(tmpdir(), "sm-proof-data-"))),
  "data",
);

// The engine reads its data dir from the environment when the graph
// is built (host/lib/Engine.ts). Set here, so a proof never writes to
// the dev app's, or to one the shell exported.
process.env.SHIGOMORI_DATA_DIR = engineDataDir;
// gh's config, which the host reads its known hosts from, as it is when
// the graph is built (host/lib/githubCli/GithubCli.ts): never the
// developer's own. A proof that installs a fake gh before then points it
// at its own.
process.env.GH_CONFIG_DIR = join(engineDataDir, "..", "gh-config");
// The shells the host opens keep their history in the run, not in the
// developer's, which a terminal a proof types into would add to. zsh's
// is named from ZDOTDIR (macOS's /etc/zshrc), so the shells start in a
// ZDOTDIR of the run's whose startup files read the developer's own under
// the developer's ZDOTDIR, wherever their .zshenv moves it, and then name
// the run's history; bash's is HISTFILE, which it takes from here.
const zdotdir = join(engineDataDir, "..", "zdotdir");
mkdirSync(zdotdir, { recursive: true });
const ownFile = (file: string) =>
  `ZDOTDIR=$SM_USER_ZDOTDIR\n[ -f "$ZDOTDIR/${file}" ] && . "$ZDOTDIR/${file}"\nZDOTDIR=$SM_RUN_ZDOTDIR\n`;
writeFileSync(
  join(zdotdir, ".zshenv"),
  'SM_RUN_ZDOTDIR=$ZDOTDIR\nZDOTDIR=${SM_USER_ZDOTDIR:-$HOME}\n[ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"\nSM_USER_ZDOTDIR=$ZDOTDIR\nZDOTDIR=$SM_RUN_ZDOTDIR\n',
);
for (const file of [".zprofile", ".zlogin", ".zlogout"]) {
  writeFileSync(join(zdotdir, file), ownFile(file));
}
writeFileSync(
  join(zdotdir, ".zshrc"),
  `${ownFile(".zshrc")}HISTFILE=$SM_RUN_ZDOTDIR/.zsh_history\n`,
);
process.env.SM_USER_ZDOTDIR = process.env.ZDOTDIR ?? "";
process.env.ZDOTDIR = zdotdir;
process.env.HISTFILE = join(zdotdir, ".bash_history");
const engine = Engine.layer({
  flavor: "dev",
  nativefs: nativefs(),
  sm: "smd",
}).pipe(Layer.provideMerge(Migration.layer));

// No file-sync engine: a proof that runs one brings its own
// (mirror.mts). The services the host's handlers answer on
// (host/process/services.ts) are here too, for a proof that runs a
// handler or serves one (runHost, hostContext).
const runtime = ManagedRuntime.make(
  Worktrees.layer.pipe(
    Layer.provideMerge(
      Scripts.layer({ hurried: () => false, env: () => process.env }),
    ),
    Layer.provideMerge(
      Terminals.layer({
        start: terminalStart,
        worktrees: terminalWorktrees,
      }),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Ports.layer,
        PullRequestMaps.layer,
        Villagers.deviceLayer,
        Views.layer,
        Sharing.layer({ announce: () => {} }),
        // Unreported, as the host starts.
        HostAccount.layer,
        Moves.layer,
        // No fetches behind a proof's back.
        Layer.succeed(
          BackgroundFetch.BackgroundFetch,
          BackgroundFetch.BackgroundFetch.of({
            refreshProject: () => Effect.void,
            sweepForPeer: () => Effect.succeed({ leaseMs: 0 }),
            setWindowFocused: () => {},
          }),
        ),
        // Over the file's fresh store, with nothing a previous run left
        // behind to sweep.
        OrphanSweep.layer,
      ),
    ),
    // The engine's deletes stop the mirrors of what they take first.
    Layer.provideMerge(Layer.effect(MirrorsOnDelete, mirrorsOnDelete("both"))),
    Layer.provideMerge(HostStandIns.pushesLayer),
    // The copy of the shared settings, read from the store and following
    // its changes.
    Layer.provideMerge(SharedSettingsStore.layer),
    Layer.provideMerge(EngineStoreChanges.layer),
    // What the app's root provides from its own wiring.
    Layer.provideMerge(HostStandIns.layer),
    Layer.provideMerge(ScriptRuns.layer),
    Layer.provideMerge(ScriptChanges.layer),
    Layer.provideMerge(FileSync.layer(() => null)),
    Layer.provideMerge(GithubCli.layer),
    Layer.provideMerge(CliShell.layer),
    Layer.provideMerge(engine),
    Layer.provideMerge(childDefaults),
    Layer.provideMerge(NodeServices.layer),
  ),
);

export type Services = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;

// With the sandbox's engine in place of this file's, once a proof has
// brought one up (sandboxEngine.mts).
export const hostContext = async () => {
  const context = await runtime.context();
  const sandbox = sandboxEngine();
  return sandbox === undefined ? context : Context.merge(context, sandbox);
};
export const runHost = async <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromiseWith(await hostContext())(effect);

export const startHost = () => runtime.context();
export const disposeHost = async () => {
  await runtime.dispose();
  rmSync(join(engineDataDir, ".."), { recursive: true, force: true });
};
