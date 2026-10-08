// The engine's services under the terminal, over Bun's SQLite. The
// darwin helper ships beside the binary.
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as CarryOver from "@shigomori/engine/CarryOver";
import * as Config from "@shigomori/engine/Config";
import * as Darwin from "@shigomori/engine/Darwin";
import * as Git from "@shigomori/engine/Git";
import * as GitHub from "@shigomori/engine/GitHub";
import * as Icons from "@shigomori/engine/Icons";
import * as Identity from "@shigomori/engine/Identity";
import * as Launchers from "@shigomori/engine/Launchers";
import * as Layout from "@shigomori/engine/Layout";
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import * as Paths from "@shigomori/engine/Paths";
import * as Registry from "@shigomori/engine/Registry";
import * as Scripts from "@shigomori/engine/Scripts";
import * as Store from "@shigomori/engine/Store";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Usage from "@shigomori/engine/Usage";
import * as WorktreeData from "@shigomori/engine/WorktreeData";
import * as Worktrees from "@shigomori/engine/Worktrees";
import type { Flavor } from "@shigomori/engine/flavor";
import * as Layer from "effect/Layer";

export const engine = (flavor: Flavor) =>
  Worktrees.layer.pipe(
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
      ),
    ),
    Layer.provideMerge(Terrier.layer),
    Layer.provideMerge(Darwin.layer(join(dirname(process.execPath), "macfs"))),
    Layer.provideMerge(
      Layer.mergeAll(Config.layer, Usage.layer, Identity.layer, Icons.layer),
    ),
    Layer.provideMerge(Git.layer),
    Layer.provideMerge(
      Store.layer((filename) => SqliteClient.make({ filename })),
    ),
    Layer.provideMerge(Paths.layer(flavor)),
  );
