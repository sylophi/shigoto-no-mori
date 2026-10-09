// The bridge between coding agents' harnesses (Claude Code, Codex, any
// other that calls in) and the worktrees they work in. A harness
// session is bound to one worktree, and the harness's hooks report the
// session's state through `sm agents event`. The app files a worktree on
// its "Agent working" shelf while any session bound to it is working.
//
// A session binds itself: any command run inside a managed worktree
// from a supported harness's shell (whose env names the session) binds
// that session there (`autoBind`), `create` binds it to the new
// worktree, and an event from an unbound session whose cwd is a managed
// worktree binds it to that one. `bind` does it explicitly. The
// bindings are the Registry's, kept by worktree id like the marks.
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  addOurs,
  codexHookHash,
  codexTrustedHashes,
  type Harness,
  HARNESSES,
  harnessById,
  hookCommand,
  hooksDocText,
  isOurCommand,
  MalformedHooksFile,
  ourEntries,
  readHooksDoc,
  removeOurs,
  snakeCase,
} from "./agentHooks.ts";
import {
  type AgentSession,
  applyAgentEvent,
  parseAgentEvent,
} from "./agentSessions.ts";
import { envVar } from "./environment.ts";
import { shellQuote } from "./Lifecycle.ts";
import * as Open from "./Open.ts";
import * as Paths from "./Paths.ts";
import { errnoText, isNotFound } from "./platformErrors.ts";
import * as Registry from "./Registry.ts";
import * as Worktrees from "./Worktrees.ts";

// One harness's hooks on this machine (`sm agents status`): whether the
// harness is set up here at all (its config dir exists), its hooks
// file, and whether the hooks that report its sessions are installed,
// installed by another build (outdated: install again) or missing.
// trusted is set for a harness that runs a hook only once the user has
// trusted it (Codex), once installed.
export type HarnessStatus = {
  readonly id: string;
  readonly label: string;
  readonly detected: boolean;
  readonly path: string;
  readonly hooks: "installed" | "outdated" | "missing";
  readonly trusted?: boolean;
};

// A session as its harness and id name it.
export type SessionRef = {
  readonly harness: string;
  readonly session: string;
};

export class UnknownHarness extends Schema.TaggedError<UnknownHarness>()(
  "UnknownHarness",
  { harness: Schema.String },
) {
  get usage(): boolean {
    return true;
  }

  override get message(): string {
    return `Unknown harness ${JSON.stringify(this.harness)}. Known: ${HARNESSES.map(({ id }) => id).join(", ")}.`;
  }
}

// An install for a harness whose config dir isn't on this machine.
export class HarnessMissing extends Schema.TaggedError<HarnessMissing>()(
  "HarnessMissing",
  { label: Schema.String, dir: Schema.String },
) {
  override get message(): string {
    return `${this.label} isn't set up here (no ${this.dir})`;
  }
}

// A hooks file that isn't one (`problem` says how), or that couldn't be
// written.
export class HooksFileError extends Schema.TaggedError<HooksFileError>()(
  "HooksFileError",
  {
    stage: Schema.Literals(["read", "write"]),
    path: Schema.String,
    problem: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.stage === "read"
      ? `${this.path} ${this.problem}. Fix it, then retry.`
      : `Couldn't write ${this.path}: ${this.problem}`;
  }
}

export class BindRefused extends Schema.TaggedError<BindRefused>()(
  "BindRefused",
  {},
) {
  override get message(): string {
    return "Only managed worktrees can be bound to an agent session, not the primary checkout or an external one";
  }
}

export class CantResume extends Schema.TaggedError<CantResume>()("CantResume", {
  harness: Schema.String,
}) {
  override get message(): string {
    return `Don't know how to resume a ${this.harness} session`;
  }
}

export class Agents extends Context.Service<
  Agents,
  {
    // The session the calling process runs in, from its env. A harness
    // run inside another one's shell carries both vars, and the inner
    // one is unknowable, so the table order decides.
    readonly caller: Effect.Effect<Option.Option<SessionRef>>;
    // A session bound outside a hook: working, since it binds from a
    // command it runs mid-turn, but only when its harness has the hooks
    // that will report the turn's end. Without them it would read
    // working for good.
    readonly starting: (
      ref: SessionRef,
    ) => Effect.Effect<Pick<AgentSession, "harness" | "session" | "state">>;
    // The binding a command makes before it runs: the caller's session
    // run inside a managed worktree binds there. Checked against a plain
    // read first, so the common case (already bound here) writes
    // nothing. Best-effort: binding is never the command's point.
    readonly autoBind: (at: Worktrees.Here) => Effect.Effect<void>;
    readonly bind: (
      worktree: Worktrees.WorktreeIdentity,
      ref: SessionRef,
    ) => Effect.Effect<void, BindRefused>;
    // Whether it was bound. It stays unbound until a command binds it
    // again.
    readonly unbind: (ref: SessionRef) => Effect.Effect<boolean>;
    // Every session bound to the worktree goes idle, for a turn whose
    // end no hook reported (Claude Code fires none on an interrupt).
    readonly idle: (
      worktree: Worktrees.WorktreeIdentity,
    ) => Effect.Effect<void>;
    // The session's own CLI picks it up again in the worktree, in the
    // user's terminal. A harness finds a session by its id from any
    // directory.
    readonly resume: (
      located: Worktrees.Located,
      ref: SessionRef,
    ) => Effect.Effect<void, CantResume | Open.LaunchFailed>;
    // One lifecycle event as the hooks send it (JSON), from a hook run
    // in `cwd`. Never fails: a missed state change is no hook's
    // business. Judged against a plain read first, so the common event
    // that changes nothing (PostToolUse mid-turn) loads no projects.
    readonly event: (
      harness: string,
      raw: string,
      cwd: string,
    ) => Effect.Effect<void>;
    // Every harness's hooks, the --json answer of status, install and
    // uninstall alike.
    readonly statuses: Effect.Effect<ReadonlyArray<HarnessStatus>>;
    // Installs or removes the hooks of the harnesses `ids` names, every
    // detected one without any, answering the status of each it acted
    // on. An uninstall skips a harness that isn't set up here, where an
    // install refuses it. Nothing to do writes nothing.
    readonly setHooks: (
      ids: ReadonlyArray<string>,
      install: boolean,
    ) => Effect.Effect<
      ReadonlyArray<HarnessStatus>,
      UnknownHarness | HarnessMissing | HooksFileError
    >;
  }
>()("sm/engine/Agents") {}

const find = (bound: Registry.BoundSessions, ref: SessionRef) => {
  for (const [id, list] of bound) {
    const index = list.findIndex(
      (s) => s.harness === ref.harness && s.session === ref.session,
    );
    if (index >= 0) return { id, list, index };
  }
  return undefined;
};

// `binary` is the terminal `sm` the hooks run. Absolute, since a
// GUI-launched harness may not have the user's PATH.
const make = (binary: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, binaryName } = yield* Paths.Paths;
    const registry = yield* Registry.Registry;
    const worktrees = yield* Worktrees.Worktrees;
    const open = yield* Open.Open;
    // By its real path, as Go's sm named itself, so the app (its bundled
    // copy) and a terminal (through the linked command) write the same
    // entry and agree on whether it is current. One not built yet (a dev
    // run) keeps the path given.
    const sm = yield* fs
      .realPath(binary)
      .pipe(Effect.orElseSucceed(() => binary));
    // The provider the engine was built with, not the caller's: a fiber
    // with none set reads a copy of the environment taken once.
    const configProvider = yield* ConfigProvider.ConfigProvider;
    const env = (name: string) =>
      envVar(name).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      );

    const command = (harness: Harness) => hookCommand(harness, sm);
    const ours = (harness: Harness) => (line: string) =>
      isOurCommand(harness, binaryName, line);

    const dirOf = (harness: Harness) =>
      Effect.map(env(harness.dirEnv), (dir) =>
        dir === "" ? path.join(home, harness.dirName) : dir,
      );
    const hooksPath = (harness: Harness) =>
      Effect.map(dirOf(harness), (dir) => path.join(dir, harness.file));
    const detected = (harness: Harness) =>
      Effect.flatMap(dirOf(harness), (dir) =>
        fs.stat(dir).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        ),
      );

    // The file a hooks path names: through a symlink (a dotfiles repo's)
    // to the file itself, even one not created yet, so a write replaces
    // the file and the link stays.
    const linkTarget = (file: string) =>
      Effect.gen(function* () {
        const target = yield* fs.readLink(file).pipe(Effect.option);
        if (Option.isNone(target)) return file;
        const real = yield* fs.realPath(file).pipe(Effect.option);
        if (Option.isSome(real)) return real.value;
        return path.isAbsolute(target.value)
          ? target.value
          : path.join(path.dirname(file), target.value);
      });

    const readDoc = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed("")),
        Effect.mapError(
          (cause) =>
            new HooksFileError({
              stage: "read",
              path: file,
              problem: "couldn't be read",
              cause,
            }),
        ),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => readHooksDoc(file, raw),
            catch: (error) =>
              new HooksFileError({
                stage: "read",
                path: file,
                problem:
                  error instanceof MalformedHooksFile
                    ? error.problem
                    : "couldn't be read",
                cause: error,
              }),
          }),
        ),
      );

    const status = (harness: Harness) =>
      Effect.gen(function* () {
        const file = yield* hooksPath(harness);
        const missing: HarnessStatus = {
          id: harness.id,
          label: harness.label,
          detected: yield* detected(harness),
          path: file,
          hooks: "missing",
        };
        const doc = yield* readDoc(file).pipe(Effect.option);
        if (Option.isNone(doc)) return missing;
        const { exact, total } = ourEntries(
          doc.value,
          harness,
          command(harness),
          ours(harness),
        );
        if (total === 0) return missing;
        if (
          total !== harness.hooks.length ||
          exact.size !== harness.hooks.length
        ) {
          return { ...missing, hooks: "outdated" } satisfies HarnessStatus;
        }
        if (!harness.trust) {
          return { ...missing, hooks: "installed" } satisfies HarnessStatus;
        }
        const toml = yield* fs
          .readFileString(path.join(yield* dirOf(harness), "config.toml"))
          .pipe(Effect.orElseSucceed(() => ""));
        const hashes = codexTrustedHashes(toml);
        // Codex keys by its config dir's resolved path and the file's
        // own name, a symlink's included.
        const keyPath = yield* fs.realPath(path.dirname(file)).pipe(
          Effect.map((dir) => path.join(dir, path.basename(file))),
          Effect.orElseSucceed(() => file),
        );
        const trusted = harness.hooks.every(
          (spec) =>
            hashes.get(
              `${keyPath}:${snakeCase(spec.event)}:${exact.get(spec.event) ?? 0}:0`,
            ) === codexHookHash(spec, command(harness)),
        );
        return {
          ...missing,
          hooks: "installed",
          trusted,
        } satisfies HarnessStatus;
      });

    const statuses = Effect.forEach(HARNESSES, status).pipe(
      Effect.withSpan("Agents.statuses"),
    );

    // Replaces the file whole, through a temp sibling, so a failed write
    // never leaves it cut short. An existing file keeps its permissions.
    const writeFile = (file: string, text: string) =>
      Effect.gen(function* () {
        const mode = yield* fs.stat(file).pipe(
          Effect.map((info) => info.mode & 0o777),
          Effect.orElseSucceed(() => 0o644),
        );
        const temp = path.join(
          path.dirname(file),
          `.${path.basename(file)}.tmp-${yield* Clock.currentTimeMillis}`,
        );
        yield* fs.writeFileString(temp, text, { mode }).pipe(
          // The mode given is masked by the umask on creation.
          Effect.andThen(fs.chmod(temp, mode)),
          Effect.andThen(fs.rename(temp, file)),
          Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore)),
        );
      });

    const setOne = (harness: Harness, install: boolean) =>
      Effect.gen(function* () {
        const file = yield* hooksPath(harness);
        const doc = yield* readDoc(file);
        const upToDate =
          install && (yield* status(harness)).hooks === "installed";
        const removed = removeOurs(doc, ours(harness));
        if (upToDate || !(removed || install)) return;
        if (install) addOurs(doc, harness, command(harness));
        const { text, empty } = hooksDocText(doc);
        // A symlinked file is someone's dotfile: it stays, emptied.
        const symlink = Option.isSome(
          yield* fs.readLink(file).pipe(Effect.option),
        );
        if (!install && harness.ownsFile && empty && !symlink) {
          yield* fs
            .remove(file)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          return;
        }
        yield* writeFile(yield* linkTarget(file), text);
      }).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.flatMap(hooksPath(harness), (file) =>
              Effect.fail(
                new HooksFileError({
                  stage: "write",
                  path: file,
                  problem: errnoText(cause),
                  cause,
                }),
              ),
            ),
        }),
      );

    const setHooks = Effect.fn("Agents.setHooks")(function* (
      ids: ReadonlyArray<string>,
      install: boolean,
    ) {
      const picked: Array<Harness> = [];
      if (ids.length === 0) {
        for (const harness of HARNESSES) {
          if (yield* detected(harness)) picked.push(harness);
        }
      } else {
        for (const id of ids) {
          const harness = harnessById(id);
          if (harness === undefined) {
            return yield* new UnknownHarness({ harness: id });
          }
          picked.push(harness);
        }
      }
      const done: Array<HarnessStatus> = [];
      for (const harness of picked) {
        if (!(yield* detected(harness))) {
          if (install) {
            return yield* new HarnessMissing({
              label: harness.label,
              dir: yield* dirOf(harness),
            });
          }
          continue;
        }
        yield* setOne(harness, install);
        done.push(yield* status(harness));
      }
      return done;
    });

    const caller = Effect.gen(function* () {
      for (const harness of HARNESSES) {
        const session = yield* env(harness.sessionEnv);
        if (session !== "")
          return Option.some({ harness: harness.id, session });
      }
      return Option.none<SessionRef>();
    });

    const starting = Effect.fn("Agents.starting")(function* (ref: SessionRef) {
      const harness = harnessById(ref.harness);
      const hooked =
        harness !== undefined && (yield* status(harness)).hooks === "installed";
      return {
        ...ref,
        state: hooked ? ("working" as const) : ("idle" as const),
      };
    });

    const autoBind = Effect.fn("Agents.autoBind")(function* (
      at: Worktrees.Here,
    ) {
      const ref = yield* caller;
      const current = at.current?.worktree;
      if (
        Option.isNone(ref) ||
        current === undefined ||
        !Worktrees.isShelfable(current)
      ) {
        return;
      }
      if (find(yield* registry.agentSessions, ref.value)?.id === current.id) {
        return;
      }
      yield* registry.bindAgentSession(yield* starting(ref.value), current.id);
    });

    const bind = Effect.fn("Agents.bind")(function* (
      worktree: Worktrees.WorktreeIdentity,
      ref: SessionRef,
    ) {
      if (!Worktrees.isShelfable(worktree)) return yield* new BindRefused();
      yield* registry.bindAgentSession(yield* starting(ref), worktree.id);
    });

    const unbind = Effect.fn("Agents.unbind")(function* (ref: SessionRef) {
      let unbound = false;
      yield* registry.updateAgentSessions((bound) => {
        const found = find(bound, ref);
        if (found === undefined) return false;
        found.list.splice(found.index, 1);
        unbound = true;
        return true;
      });
      return unbound;
    });

    const idle = Effect.fn("Agents.idle")(function* (
      worktree: Worktrees.WorktreeIdentity,
    ) {
      const now = yield* Clock.currentTimeMillis;
      yield* registry.updateAgentSessions((bound) => {
        const list = bound.get(worktree.id) ?? [];
        let changed = false;
        list.forEach((session, index) => {
          if (session.state === "idle") return;
          const { waits: _waits, tool: _tool, need: _need, ...kept } = session;
          list[index] = { ...kept, state: "idle", at: now };
          changed = true;
        });
        return changed;
      });
    });

    const resume = Effect.fn("Agents.resume")(function* (
      located: Worktrees.Located,
      ref: SessionRef,
    ) {
      const harness = harnessById(ref.harness);
      if (harness === undefined || harness.resume === "") {
        return yield* new CantResume({ harness: ref.harness });
      }
      yield* open.inTerminal(
        located,
        `${harness.resume} ${shellQuote(ref.session)}`,
      );
    });

    const onEvent = Effect.fn("Agents.event")(function* (
      harnessId: string,
      raw: string,
      cwd: string,
    ) {
      const event = parseAgentEvent(raw);
      if (event === undefined) {
        return yield* Effect.logDebug("agents event: unreadable payload");
      }
      const harness = harnessById(harnessId);
      let key = event.session;
      if (harness?.subagentIds === true && event.agentId !== "") {
        key = event.agentId;
      } else if (event.name === "SubagentStop") {
        // The parent's session id: its subagent ending isn't its end.
        return;
      }
      const ref = { harness: harnessId, session: key };
      const now = yield* Clock.currentTimeMillis;
      const found = find(yield* registry.agentSessions, ref);
      if (found === undefined) {
        // An unbound session started in a managed worktree belongs to it.
        const next = applyAgentEvent({ ...ref, state: "", at: 0 }, event, now);
        if (next === undefined || next === "unbind") return;
        const at = yield* worktrees.here(event.cwd === "" ? cwd : event.cwd);
        const current = at.current?.worktree;
        if (current === undefined || !Worktrees.isShelfable(current)) return;
        const { at: _at, ...session } = next;
        return yield* registry.bindAgentSession(session, current.id);
      }
      const session = found.list[found.index];
      if (
        session === undefined ||
        applyAgentEvent(session, event, now) === undefined
      ) {
        return;
      }
      yield* registry.updateAgentSessions((bound) => {
        const again = find(bound, ref);
        const current = again?.list[again.index];
        if (again === undefined || current === undefined) return false;
        const next = applyAgentEvent(current, event, now);
        if (next === undefined) return false;
        if (next === "unbind") again.list.splice(again.index, 1);
        else again.list[again.index] = next;
        return true;
      });
    });

    return Agents.of({
      caller,
      starting,
      autoBind: (at) =>
        autoBind(at).pipe(
          Effect.catchCause((cause) => Effect.logDebug("agents: bind", cause)),
        ),
      bind,
      unbind,
      idle,
      resume,
      event: (harness, raw, cwd) =>
        onEvent(harness, raw, cwd).pipe(
          Effect.catchCause((cause) => Effect.logDebug("agents event", cause)),
        ),
      statuses,
      setHooks,
    });
  });

export const layer = (binary: string) => Layer.effect(Agents, make(binary));
