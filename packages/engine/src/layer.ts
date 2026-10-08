// The engine's layer graph, which each process that runs the engine
// builds once: its store over the process's SQLite driver, its flavor,
// and where the darwin helper (macfs) is.
import * as CarryOver from "./CarryOver.ts";
import * as CloneCheckout from "./CloneCheckout.ts";
import * as Config from "./Config.ts";
import * as Darwin from "./Darwin.ts";
import * as Doctor from "./Doctor.ts";
import type { Flavor } from "./flavor.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import * as Hygiene from "./Hygiene.ts";
import * as Icons from "./Icons.ts";
import * as Identity from "./Identity.ts";
import * as Launchers from "./Launchers.ts";
import * as Layout from "./Layout.ts";
import * as Lifecycle from "./Lifecycle.ts";
import * as Paths from "./Paths.ts";
import * as Registry from "./Registry.ts";
import * as Scripts from "./Scripts.ts";
import type * as Store from "./Store.ts";
import * as Terrier from "./Terrier.ts";
import * as Usage from "./Usage.ts";
import * as WorktreeData from "./WorktreeData.ts";
import * as Worktrees from "./Worktrees.ts";
import * as Layer from "effect/Layer";

export const engineLayer = (options: {
  readonly flavor: Flavor;
  readonly store: ReturnType<typeof Store.layer>;
  readonly macfs: string;
}) =>
  Layer.mergeAll(Hygiene.layer, Doctor.layer).pipe(
    Layer.provideMerge(Worktrees.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Launchers.layer,
        Layout.layer,
        Registry.layer,
        Scripts.layer,
        WorktreeData.layer,
        GitHub.layer,
        Lifecycle.layer,
        CarryOver.layer,
        CloneCheckout.layer,
      ),
    ),
    Layer.provideMerge(Terrier.layer),
    Layer.provideMerge(Darwin.layer(options.macfs)),
    Layer.provideMerge(
      Layer.mergeAll(Config.layer, Usage.layer, Identity.layer, Icons.layer),
    ),
    Layer.provideMerge(Git.layer),
    Layer.provideMerge(options.store),
    Layer.provideMerge(Paths.layer(options.flavor)),
  );
