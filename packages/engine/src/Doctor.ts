// `sm doctor`: why sm is behaving weirdly. It answers three questions
// the other commands can only fail at. Is this installation intact
// (git, gh, the app bundle behind the binary, PATH, the shell hook)? Is
// the data dir consistent (no lock a crashed process left behind, no
// project whose repo is gone, git's worktree metadata agreeing with the
// disk, launchers and carry-over naming things that exist)? And did a
// crash leave anything behind (a tunnel or dev server still running,
// update downloads, transfer refs)?
//
// The checks only read. A repair whose outcome is unambiguous rides on
// its finding and runs only when the caller asks for the fix: delete a
// stale lock, unregister a project whose repo is gone, re-link a moved
// worktree, `git worktree prune`. Anything with a judgment call in it is
// reported with a suggested fix and never touched. The document keeps
// the shape `sm doctor --json` prints, field for field.
//
// The terminal's `sm doctor` must answer when the store can't open
// (`standalone`): the checks that read only files and programs still
// run, and the file the store refused is named as Go named it.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { makeReads } from "./doctor/reads.ts";
import { makeEnvironmentChecks } from "./doctor/environmentChecks.ts";
import { makeDataDirChecks } from "./doctor/dataDirChecks.ts";
import { makeLeftoverChecks } from "./doctor/leftoverChecks.ts";
import { makeProjectChecks } from "./doctor/projectChecks.ts";
import { makeChecklist } from "./doctor/checklist.ts";
import { makeFileReads } from "./doctor/fileReads.ts";
import { makeWithoutStore } from "./doctor/withoutStore.ts";
import { makeFinishing } from "./doctor/finishing.ts";
import {
  type DoctorDocument,
  type FileReads,
  type RunInput,
  type StoreServices,
  isStoreImportError,
} from "./doctor/documents.ts";
export { MovedWorktreePending, WorktreesNotMoved } from "./doctor/documents.ts";
export type {
  DoctorDocument,
  Finding,
  Group,
  Repair,
  RunInput,
  Status,
} from "./doctor/documents.ts";

export class Doctor extends Context.Service<
  Doctor,
  {
    // Every check, in the order the checklist prints. With `fix`, the
    // repairs the findings offer run in that order and the checks run
    // again, so the document describes the world after them. A failed
    // repair is reported and the rest still run.
    readonly run: (input: RunInput) => Effect.Effect<DoctorDocument>;
  }
>()("sm/engine/Doctor") {}

const make = Effect.gen(function* () {
  const reads = yield* makeReads;
  const environmentChecks = yield* makeEnvironmentChecks({ reads });
  const dataDirChecks = yield* makeDataDirChecks({ reads });
  const leftoverChecks = yield* makeLeftoverChecks({ reads });
  const projectChecks = yield* makeProjectChecks({ reads, dataDirChecks });
  const checklist = yield* makeChecklist({
    environmentChecks,
    dataDirChecks,
    leftoverChecks,
    projectChecks,
  });
  const fileReads = yield* makeFileReads({ dataDirChecks });
  const withoutStore = yield* makeWithoutStore({ dataDirChecks, checklist });
  const finishing = yield* makeFinishing;
  const { checkDataDir } = dataDirChecks;
  const { checkAll } = checklist;
  const { readFiles } = fileReads;
  const { checkWithoutState } = withoutStore;
  const { finish } = finishing;
  return {
    // Every check, given the store's services. With `files`, they read
    // the 2.x files the store refused.
    run: (input: RunInput, files: Option.Option<FileReads>) =>
      finish(input, checkAll(input, files)),
    readFiles,
    // The checks that need no state, `failed` when the store wouldn't
    // open.
    withoutState: (input: RunInput, failed: boolean) =>
      finish(input, checkWithoutState(input, failed)),
    // Whether there is a data dir the store could open in.
    dataDirUsable: Effect.map(checkDataDir, ({ usable }) => usable),
  };
});

export const layer = Layer.effect(
  Doctor,
  Effect.gen(function* () {
    const checks = yield* make;
    const store = yield* Effect.context<StoreServices>();
    return Doctor.of({
      run: Effect.fn("Doctor.run")(function* (input: RunInput) {
        return yield* Effect.provideContext(
          checks.run(input, Option.none()),
          store,
        );
      }),
    });
  }),
);

// The doctor for a data dir the store may not open, as `sm doctor`
// needs it. `store` provides the store's services and is built inside
// each run, and `files` the same services over the 2.x files
// (`Store.fromFiles`). An import the store refused reads the files
// instead, as Go did. Any other failure to open, or no data dir to
// open one in (which building it would create), runs only the checks
// that need no state.
export const standalone = <R>(
  store: Layer.Layer<StoreServices, unknown, R>,
  files: Layer.Layer<StoreServices, unknown, R>,
) =>
  Layer.effect(
    Doctor,
    Effect.gen(function* () {
      const checks = yield* make;
      const context = yield* Effect.context<R>();
      return Doctor.of({
        run: Effect.fn("Doctor.run")(function* (input: RunInput) {
          if (!(yield* checks.dataDirUsable)) {
            return yield* checks.withoutState(input, false);
          }
          return yield* Effect.gen(function* () {
            const built = yield* Effect.exit(Layer.build(store));
            if (Exit.isSuccess(built)) {
              return yield* Effect.provideContext(
                checks.run(input, Option.none()),
                built.value,
              );
            }
            if (Cause.hasInterruptsOnly(built.cause)) {
              return yield* Effect.interrupt;
            }
            const refused = Option.filter(
              Cause.findErrorOption(built.cause),
              isStoreImportError,
            );
            if (Option.isNone(refused)) {
              return yield* checks.withoutState(input, true);
            }
            const read = yield* Effect.exit(Layer.build(files));
            if (Exit.isFailure(read)) {
              return yield* checks.withoutState(input, true);
            }
            return yield* Effect.provideContext(
              checks.run(
                input,
                Option.some(yield* checks.readFiles(refused.value)),
              ),
              read.value,
            );
          }).pipe(Effect.scoped, Effect.provideContext(context));
        }),
      });
    }),
  );
