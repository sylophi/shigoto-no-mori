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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { shellQuote as quoted } from "@shigomori/contracts/lifecycleScripts";
import { childDefaults } from "@shigomori/engine/processes";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
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
import * as Sharing from "../../host/lib/Sharing.ts";
import * as Moves from "../../host/lib/sync/Moves.ts";
import * as OrphanSweep from "../../host/lib/scripts/OrphanSweep.ts";
import * as Views from "../../host/lib/Views.ts";
import * as SharedSettingsStore from "../../host/lib/sharedSettings/store.ts";
import * as EngineStoreChanges from "@shigomori/engine/StoreChanges";
import * as Ports from "../../host/lib/Ports.ts";
import { sandboxEngine } from "./sandboxEngine.mts";
import * as Villagers from "../../host/lib/VillagerData.ts";
import * as Worktrees from "../../host/lib/Worktrees.ts";
import { terminalStart, terminalWorktrees } from "../../host/ipc/scriptRun.ts";
import * as HostStandIns from "./hostStandIns.mts";
import { macfs } from "../../../packages/engine/test/lib/macfs.ts";

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
// developer's ~/.zsh_history, which a terminal a proof types into would
// add to: macOS's /etc/zshrc sets HISTFILE from ZDOTDIR, so this ZDOTDIR
// has startup files that read the developer's own, then name the run's.
const userZdotdir = process.env.ZDOTDIR ?? homedir();
const zdotdir = join(engineDataDir, "..", "zdotdir");
mkdirSync(zdotdir, { recursive: true });
for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
  const own = join(userZdotdir, file);
  writeFileSync(
    join(zdotdir, file),
    `[ -f ${quoted(own)} ] && . ${quoted(own)}\n` +
      (file === ".zshrc"
        ? `HISTFILE=${quoted(join(zdotdir, ".zsh_history"))}\n`
        : ""),
  );
}
process.env.ZDOTDIR = zdotdir;
const engine = Engine.layer({
  flavor: "dev",
  macfs: macfs(),
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
    Layer.provideMerge(
      Layer.mergeAll(HostStandIns.pushesLayer, EngineStoreChanges.layer),
    ),
    // The copy of the shared settings, read from the store.
    Layer.provideMerge(SharedSettingsStore.layer),
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

// A service of the host built again for a proof, not the graph's: over
// the environment as it is now, read through Config as the graph reads
// it.
export const builtNow = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.fresh(layer).pipe(
    Layer.provide(
      ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromEnv())),
    ),
  );

// The service a layer builds, built as builtNow builds it and up until
// `track`'s test ends, its lookups and fibers with it.
export const serviceBuiltNow = async <I, S, E>(
  tag: Context.Key<I, S>,
  layer: Layer.Layer<I, E, Services>,
  track: (teardown: () => Promise<void>) => unknown,
): Promise<S> => {
  const scope = Scope.makeUnsafe();
  track(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const context = await runHost(Layer.buildWithScope(builtNow(layer), scope));
  return Context.get(context, tag);
};

export const startHost = () => runtime.context();
export const disposeHost = async () => {
  await runtime.dispose();
  rmSync(join(engineDataDir, ".."), { recursive: true, force: true });
};
