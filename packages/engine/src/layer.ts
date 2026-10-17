// The engine's layer graph, which each process that runs the engine
// builds once: its store over the process's SQLite driver, its flavor,
// where the darwin helper (macfs) is, and the terminal `sm` the agent
// hooks run. The updater talks HTTP through
// fetch, the one client Node and Bun both have.
import * as DataDirLock from "./DataDirLock.ts";
import * as DataDirMove from "./dataDirMove.ts";
import * as Agents from "./Agents.ts";
import * as Bundle from "./Bundle.ts";
import * as CarryOver from "./CarryOver.ts";
import * as CloneCheckout from "./CloneCheckout.ts";
import * as Config from "./Config.ts";
import * as Control from "./Control.ts";
import * as Darwin from "./Darwin.ts";
import * as Dirty from "./Dirty.ts";
import * as Doctor from "./Doctor.ts";
import type { Flavor } from "./flavor.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import * as Hygiene from "./Hygiene.ts";
import * as Icons from "./Icons.ts";
import * as Identity from "./Identity.ts";
import * as Launchers from "./Launchers.ts";
import * as Landing from "./Landing.ts";
import * as Layout from "./Layout.ts";
import * as Lifecycle from "./Lifecycle.ts";
import * as Migration from "./Migration.ts";
import * as MirrorAgreements from "./MirrorAgreements.ts";
import * as MirrorHistory from "./MirrorHistory.ts";
import * as MirrorInvites from "./MirrorInvites.ts";
import * as Open from "./Open.ts";
import * as Paths from "./Paths.ts";
import * as Projects from "./Projects.ts";
import * as Registry from "./Registry.ts";
import * as RunningScripts from "./RunningScripts.ts";
import * as SavedTerminals from "./SavedTerminals.ts";
import * as Scripts from "./Scripts.ts";
import * as ShellIntegration from "./ShellIntegration.ts";
import * as SharedSettings from "./SharedSettings.ts";
import * as Store from "./Store.ts";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Terrier from "./Terrier.ts";
import * as Transfer from "./Transfer.ts";
import * as Updater from "./Updater.ts";
import * as Usage from "./Usage.ts";
import * as WorktreeData from "./WorktreeData.ts";
import * as Worktrees from "./Worktrees.ts";
import * as WtFolder from "./WtFolder.ts";
import { childDefaults } from "./processes.ts";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

type EngineOptions = {
  readonly flavor: Flavor;
  readonly store: ReturnType<typeof Store.layer>;
  // The driver's open, which the data-folder lock's database takes too.
  readonly open: Store.OpenDatabase;
  readonly macfs: string;
  readonly sm: string;
};

// Every service but Paths, which is built once beside them.
const services = (options: EngineOptions) =>
  Agents.layer(options.sm).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Landing.layer,
        Projects.layer,
        Doctor.layer,
        Transfer.layer,
        Dirty.layer,
        Bundle.layer,
        Open.layer,
      ),
    ),
    Layer.provideMerge(Hygiene.layer),
    Layer.provideMerge(WtFolder.layer),
    Layer.provideMerge(Worktrees.layer),
    Layer.provideMerge(Control.layer(options.flavor)),
    Layer.provideMerge(
      Layer.mergeAll(
        Launchers.layer,
        Layout.layer,
        ShellIntegration.layer,
        Registry.layer,
        Scripts.layer,
        WorktreeData.layer,
        GitHub.layer,
        Lifecycle.layer,
        CarryOver.layer,
        Updater.layer(options.flavor).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    ),
    // Below Registry, which forgets a removed project's clone records.
    Layer.provideMerge(CloneCheckout.layer),
    Layer.provideMerge(Terrier.layer),
    Layer.provideMerge(Darwin.layer(options.macfs)),
    Layer.provideMerge(
      Layer.mergeAll(
        Config.layer,
        Usage.layer,
        Identity.layer,
        Icons.layer,
        SharedSettings.layer,
        SavedTerminals.layer,
        RunningScripts.layer,
        MirrorAgreements.layer,
        MirrorHistory.layer,
        MirrorInvites.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(Git.layer, DataDirLock.layer(options.open)),
    ),
    Layer.provideMerge(options.store),
    Layer.provideMerge(childDefaults),
  );

// A data-folder move's journal settled as the graph comes up, before
// anything reads a worktree by its id (DataDirMove.settleLayer).
export const engineLayer = (options: EngineOptions) =>
  DataDirMove.settleLayer.pipe(
    Layer.provideMerge(services(options)),
    Layer.provideMerge(Paths.layer(options.flavor)),
  );

// The engine of the process that migrates a 2.x data dir, the app's:
// its moves into `wt/` made before anything else runs. Every other
// process leaves them to it (`Store.importOwed`).
export const migratingEngineLayer = (options: EngineOptions) =>
  WtFolder.drained.pipe(Layer.provideMerge(engineLayer(options)));

// The store-backed services the doctor's checks read, over `store`.
const doctorStore = <E, R>(store: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  WtFolder.layer.pipe(
    Layer.provideMerge(Worktrees.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layout.layer,
        Registry.layer,
        WorktreeData.layer,
        GitHub.layer,
        Lifecycle.layer,
        CarryOver.layer,
      ),
    ),
    Layer.provideMerge(CloneCheckout.layer),
    Layer.provideMerge(Terrier.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Config.layer,
        Usage.layer,
        Identity.layer,
        Icons.layer,
        RunningScripts.layer,
      ),
    ),
    Layer.provideMerge(store),
  );

// The terminal's `sm doctor`, which answers when the store can't open:
// the store is opened inside each run (`Doctor.standalone`), with a
// migration of its own that nothing shows. Paths comes along for the
// checklist's header.
export const doctorLayer = (options: {
  readonly flavor: Flavor;
  readonly open: Store.OpenDatabase;
  readonly macfs: string;
}) =>
  Doctor.standalone(
    doctorStore(Store.layer(options.open)),
    doctorStore(Store.fromFiles(options.open, true)),
    doctorStore(Store.fromFiles(options.open, false)),
    Store.importOwed(options.open),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(Git.layer, Darwin.layer(options.macfs), Migration.layer),
    ),
    // `--fix` prunes and moves worktrees, which a data-folder move holds
    // still.
    Layer.merge(DataDirLock.layer(options.open)),
    Layer.provideMerge(Paths.layer(options.flavor)),
    Layer.provideMerge(childDefaults),
  );
