// Agent sessions: they bind (create, any command inside a worktree, an
// event from a session started in one), events move their state, the
// row derives agentWorking from them, and rm drops them. install edits a
// hooks file without disturbing the rest of it. Against real git on a
// sandbox data dir.
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, describe, it } from "vitest";
import * as Agents from "../src/Agents.ts";
import {
  codexHookHash,
  HARNESSES,
  hookCommand,
  snakeCase,
} from "../src/agentHooks.ts";
import {
  AGENT_MESSAGE_MAX,
  type AgentSession,
  clipLine,
} from "../src/agentSessions.ts";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import {
  type Engine,
  HOOK_BINARY,
  type Sandbox,
  sandbox,
} from "./lib/sandbox.ts";

let box: Sandbox | undefined;
afterEach(async () => {
  await box?.remove();
  box = undefined;
});

// The running test's sandbox.
const current = (): Sandbox => {
  if (box === undefined) throw new Error("no sandbox");
  return box;
};

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "agents-")));

const silent: Worktrees.Reporter = {
  report: () => Effect.void,
  color: false,
};

// Fails the test with the engine's error document.
async function engine<A, E>(run: Effect.Effect<A, E, Engine>): Promise<A> {
  const result = await current().engine(run);
  if (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false
  ) {
    throw new Error(JSON.stringify(result));
  }
  return result as A;
}

const agents = Effect.service(Agents.Agents);
const worktrees = Effect.service(Worktrees.Worktrees);

// A project with a repo, on a sandbox whose environment holds `env`.
async function project(env: Record<string, string> = {}) {
  box = sandbox({ env });
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const added = await engine(
    Effect.flatMap(Effect.service(Registry.Registry), (registry) =>
      registry.register({ name: "proj", path: repo }),
    ),
  );
  return { repo, project: added };
}

type Project = Awaited<ReturnType<typeof project>>;

// A new worktree, made as `sm create` makes it: with the caller's
// session bound from the start.
const create = (at: Project, name: string) =>
  engine(
    Effect.gen(function* () {
      const caller = yield* (yield* agents).caller;
      const agentSession = Option.isSome(caller)
        ? yield* (yield* agents).starting(caller.value)
        : undefined;
      const created = yield* (yield* worktrees).create(
        at.project,
        { name, skipSetup: true, agentSession },
        silent,
      );
      return created.worktree;
    }),
  );

const sessionsOf = (worktreeId: string) =>
  engine(
    Effect.map(
      Effect.flatMap(
        Effect.service(Registry.Registry),
        (registry) => registry.agentSessions,
      ),
      (bound): ReadonlyArray<AgentSession> => bound.get(worktreeId) ?? [],
    ),
  );

const located = (at: Project, worktreeId: string) =>
  Effect.gen(function* () {
    const service = yield* worktrees;
    return yield* service.resolve(yield* service.here("/"), {
      projectId: at.project.id,
      worktreeId,
    });
  });

const rowOf = (at: Project, worktreeId: string) =>
  engine(
    Effect.flatMap(located(at, worktreeId), (where) =>
      Effect.flatMap(worktrees, (service) => service.row(where)),
    ),
  );

const send = (
  harness: string,
  name: string,
  session: string,
  extra: Record<string, unknown> = {},
) =>
  engine(
    Effect.flatMap(agents, (service) =>
      service.event(
        harness,
        JSON.stringify({
          hook_event_name: name,
          session_id: session,
          ...extra,
        }),
        "/",
      ),
    ),
  );

const setHooks = (ids: ReadonlyArray<string>, install: boolean) =>
  current().engine(
    Effect.flatMap(agents, (service) => service.setHooks(ids, install)),
  );

const statusOf = async (id: string) =>
  (
    (await engine(
      Effect.flatMap(agents, (service) => service.statuses),
    )) as ReadonlyArray<Agents.HarnessStatus>
  ).find((status) => status.id === id);

// Claude Code set up in a config dir of its own, its shell running
// `session`.
const withClaude = (session?: string) => {
  const dir = scratch();
  return {
    dir,
    env: {
      CLAUDE_CONFIG_DIR: dir,
      ...(session === undefined ? {} : { CLAUDE_CODE_SESSION_ID: session }),
    },
  };
};

const states = async (worktreeId: string) =>
  (await sessionsOf(worktreeId)).map(({ state }) => state);

// An event of `session`'s, then the worktree's sessions.
const after = async (
  worktreeId: string,
  session: string,
  event: string,
  extra: Record<string, unknown>,
) => {
  await send("claude", event, session, extra);
  return sessionsOf(worktreeId);
};

const bash = (command: string) => ({
  tool_name: "Bash",
  tool_input: { command },
});

describe("sessions", () => {
  // Without the hooks nothing would ever report the turn's end, so a
  // session binds idle.
  it("binds idle without the hooks", async () => {
    const at = await project(withClaude("s0").env);
    const fox = await create(at, "fox");
    assert.deepEqual(await states(fox.id), ["idle"]);
  });

  it("moves through a turn, and rebinds and unbinds", async () => {
    const at = await project(withClaude("s1").env);
    assert.deepEqual((await setHooks(["claude"], true)) as unknown[], [
      await statusOf("claude"),
    ]);
    const fox = await create(at, "fox");
    assert.equal(fox.agentWorking, true);
    assert.deepEqual(
      fox.agentSessions.map(({ session, state }) => [session, state]),
      [["s1", "working"]],
    );
    for (const [event, extra, want] of [
      ["Stop", {}, "idle"],
      // A late async PostToolUse can't revive a finished turn.
      ["PostToolUse", {}, "idle"],
      ["UserPromptSubmit", {}, "working"],
      ["PermissionRequest", {}, "waiting"],
      ["PostToolUse", {}, "working"],
      ["PermissionRequest", {}, "waiting"],
      ["PostToolUseFailure", {}, "working"],
      ["Notification", { notification_type: "permission_prompt" }, "working"],
      ["Notification", { notification_type: "idle_prompt" }, "idle"],
    ] as const) {
      assert.deepEqual(
        // oxlint-disable-next-line no-await-in-loop -- each event lands on the one before it
        (await after(fox.id, "s1", event, extra)).map(({ state }) => state),
        [want],
        `after ${event}`,
      );
    }
    assert.equal((await rowOf(at, fox.id)).agentWorking, false);

    // Running sm inside another worktree moves the binding there.
    const owl = await create(at, "owl");
    assert.deepEqual(await states(fox.id), []);
    const autoBind = (path: string) =>
      engine(
        Effect.gen(function* () {
          const here = yield* (yield* worktrees).here(path);
          yield* (yield* agents).autoBind(here);
        }),
      );
    await autoBind(fox.path);
    assert.equal((await sessionsOf(fox.id)).length, 1);
    assert.equal((await sessionsOf(owl.id)).length, 0);

    const unbind = () =>
      engine(
        Effect.flatMap(agents, (service) =>
          service.unbind({ harness: "claude", session: "s1" }),
        ),
      );
    assert.equal(await unbind(), true);
    assert.deepEqual(await sessionsOf(fox.id), []);
    assert.equal(await unbind(), false);

    await autoBind(fox.path);
    await send("claude", "SessionEnd", "s1");
    assert.deepEqual(await sessionsOf(fox.id), []);
  });

  it("binds a session that starts inside a worktree", async () => {
    const at = await project();
    const fox = await create(at, "fox");
    await send("claude", "UserPromptSubmit", "s2", { cwd: at.repo });
    assert.deepEqual(
      await engine(
        Effect.map(
          Effect.flatMap(
            Effect.service(Registry.Registry),
            (registry) => registry.agentSessions,
          ),
          (bound) => bound.size,
        ),
      ),
      0,
    );
    await send("claude", "UserPromptSubmit", "s2", { cwd: fox.path });
    assert.deepEqual(await states(fox.id), ["working"]);
  });

  it("refuses to bind the primary checkout, and rm drops a binding", async () => {
    const at = await project();
    const fox = await create(at, "fox");
    const primary = (await engine(
      Effect.flatMap(worktrees, (service) => service.identities(at.project)),
    )) as ReadonlyArray<Worktrees.WorktreeIdentity>;
    const bind = (worktree: Worktrees.WorktreeIdentity) =>
      current().engine(
        Effect.flatMap(agents, (service) =>
          service.bind(worktree, { harness: "pi", session: "s3" }),
        ),
      );
    const primaryCheckout = primary.find((w) => w.isPrimary);
    const foxIdentity = primary.find((w) => w.id === fox.id);
    assert.ok(primaryCheckout && foxIdentity);
    assert.deepEqual(await bind(primaryCheckout), {
      ok: false,
      error:
        "Only managed worktrees can be bound to an agent session, not the primary checkout or an external one",
    });
    await bind(foxIdentity);
    await engine(
      Effect.flatMap(agents, (service) => service.idle(foxIdentity)),
    );
    assert.deepEqual(
      (await sessionsOf(fox.id)).map(({ harness, state }) => [harness, state]),
      [["pi", "idle"]],
    );
    await engine(
      Effect.flatMap(located(at, fox.id), (where) =>
        Effect.flatMap(worktrees, (service) =>
          service.remove(
            where,
            { force: true, keepBranch: false, skipCleanup: true },
            silent,
          ),
        ),
      ),
    );
    assert.deepEqual(await sessionsOf(fox.id), []);
  });

  // resume types the harness's own resume into the terminal, in the
  // worktree, and refuses a harness it can't resume.
  it("resumes a session in the terminal", async () => {
    const at = await project();
    const fox = await create(at, "fox");
    const args = join(current().home, "osascript.args");
    current().fakeBin("osascript", `printf '%s\\n' "$@" > '${args}'`);
    const resume = (harness: string, session: string) =>
      current().engine(
        Effect.flatMap(located(at, fox.id), (where) =>
          Effect.flatMap(agents, (service) =>
            service.resume(where, { harness, session }),
          ),
        ),
      );
    await resume("codex", "s4");
    assert.ok(
      readFileSync(args, "utf8").endsWith(
        `cd '${fox.path}'\ncodex resume 's4'\n`,
      ),
    );
    assert.deepEqual(await resume("pi", "s5"), {
      ok: false,
      error: "Don't know how to resume a pi session",
    });
  });

  // A tool finishing closes only its own permission prompt, whatever
  // order the hooks land in.
  it("waits on each prompt", async () => {
    const claude = withClaude("s4");
    const at = await project(claude.env);
    await setHooks(["claude"], true);
    const fox = await create(at, "fox");
    const test = {
      tool_name: "Bash",
      tool_input: { command: "pnpm test", description: "run" },
    };
    // The same input with its keys the other way round.
    const bashAgain = {
      tool_name: "Bash",
      tool_input: { description: "run", command: "pnpm test" },
    };
    const edit = { tool_name: "Edit", tool_input: { file_path: "a.go" } };
    const read = { tool_name: "Read", tool_input: { file_path: "b.go" } };
    for (const [event, extra, want] of [
      ["UserPromptSubmit", {}, "working"],
      ["PermissionRequest", test, "waiting"],
      ["PermissionRequest", edit, "waiting"],
      // A tool that asked nothing.
      ["PostToolUse", read, "waiting"],
      ["PostToolUse", bashAgain, "waiting"],
      ["PostToolUseFailure", edit, "working"],
    ] as const) {
      assert.deepEqual(
        // oxlint-disable-next-line no-await-in-loop -- each event lands on the one before it
        (await after(fox.id, "s4", event, extra)).map(({ state }) => state),
        [want],
        `after ${event}`,
      );
    }
  });

  // A session keeps its title (its first prompt, until a custom title
  // takes over), what its newest prompt asks, and the message its turn
  // ended on. A question's PostToolUse, which adds the answers to its
  // input, still closes it.
  it("keeps what the app says of it", async () => {
    const at = await project(withClaude("s6").env);
    await setHooks(["claude"], true);
    const fox = await create(at, "fox");
    const questions = [
      {
        question: "Cats or dogs?",
        header: "Pet",
        options: [{ label: "Cats" }, { label: "Dogs" }],
      },
    ];
    const question = {
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    };
    const answered = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions,
        answers: { "Cats or dogs?": "Cats" },
        annotations: {},
      },
    };
    const title = "Fix the flaky test";
    const steps: ReadonlyArray<
      readonly [string, Record<string, unknown>, Partial<AgentSession>]
    > = [
      [
        "UserPromptSubmit",
        { prompt: "Fix the\n  flaky   test" },
        { state: "working", title },
      ],
      [
        "PermissionRequest",
        bash("pnpm test"),
        { state: "waiting", title, tool: "Bash", need: "pnpm test" },
      ],
      ["PostToolUse", bash("pnpm test"), { state: "working", title }],
      [
        "PermissionRequest",
        question,
        {
          state: "waiting",
          title,
          tool: "AskUserQuestion",
          need: "Cats or dogs?",
        },
      ],
      ["PostToolUse", answered, { state: "working", title }],
      // Two open at once, the newer answered first: the older one speaks
      // again.
      [
        "PermissionRequest",
        bash("pnpm lint"),
        { state: "waiting", title, tool: "Bash", need: "pnpm lint" },
      ],
      [
        "PermissionRequest",
        question,
        {
          state: "waiting",
          title,
          tool: "AskUserQuestion",
          need: "Cats or dogs?",
        },
      ],
      [
        "PostToolUse",
        answered,
        { state: "waiting", title, tool: "Bash", need: "pnpm lint" },
      ],
      ["PostToolUse", bash("pnpm lint"), { state: "working", title }],
      [
        "PermissionRequest",
        {
          cwd: "/w/fox",
          tool_name: "Edit",
          tool_input: { file_path: "/w/fox/app/lease.ts" },
        },
        { state: "waiting", title, tool: "Edit", need: "app/lease.ts" },
      ],
      [
        "PostToolUse",
        {
          cwd: "/w/fox",
          tool_name: "Edit",
          tool_input: { file_path: "/w/fox/app/lease.ts" },
        },
        { state: "working", title },
      ],
      [
        "Stop",
        { last_assistant_message: "Cats it is." },
        { state: "idle", title, message: "Cats it is." },
      ],
      [
        "UserPromptSubmit",
        { prompt: "Now the next one" },
        { state: "working", title },
      ],
      [
        "UserPromptSubmit",
        { prompt: "go", session_title: "flaky-tests" },
        { state: "working", title: "flaky-tests" },
      ],
    ];
    for (const [event, extra, want] of steps) {
      // oxlint-disable-next-line no-await-in-loop -- each event lands on the one before it
      const [got] = await after(fox.id, "s6", event, extra);
      assert.deepEqual(
        {
          state: got?.state,
          title: got?.title,
          tool: got?.tool,
          need: got?.need,
          message: got?.message,
        },
        {
          state: want.state,
          title: want.title,
          tool: want.tool,
          need: want.need,
          message: want.message,
        },
        `after ${event}`,
      );
    }
    assert.equal(
      [...clipLine("a".repeat(500), AGENT_MESSAGE_MAX)].length,
      AGENT_MESSAGE_MAX,
    );
  });

  // A Codex subagent binds under its own thread id, its events name it
  // by agent_id beside the parent's session_id, and its SubagentStop
  // unbinds it alone.
  it("keeps a Codex subagent's session apart", async () => {
    const at = await project();
    const fox = await create(at, "fox");
    const owl = await create(at, "owl");
    await send("codex", "UserPromptSubmit", "parent", { cwd: fox.path });
    await send("codex", "UserPromptSubmit", "parent", {
      agent_id: "child",
      cwd: owl.path,
    });
    assert.deepEqual(
      (await sessionsOf(fox.id)).map(({ session }) => session),
      ["parent"],
    );
    assert.deepEqual(
      (await sessionsOf(owl.id)).map(({ session }) => session),
      ["child"],
    );
    await send("codex", "SubagentStop", "parent", { agent_id: "child" });
    assert.equal((await sessionsOf(fox.id)).length, 1);
    assert.equal((await sessionsOf(owl.id)).length, 0);
  });
});

describe("hooks", () => {
  const original = `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ]
  },
  "env": {
    "B": "1",
    "A": "2"
  }
}
`;

  it("installs without disturbing the rest of the file", async () => {
    const claude = withClaude();
    box = sandbox({ env: claude.env });
    const path = join(claude.dir, "settings.json");
    writeFileSync(path, original, { mode: 0o600 });
    const before = await statusOf("claude");
    assert.equal(before?.hooks, "missing");
    assert.equal(before?.detected, true);

    await setHooks(["claude"], true);
    const installed = await statusOf("claude");
    assert.equal(installed?.hooks, "installed");
    assert.equal(installed?.trusted, undefined);
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes("say done"));
    assert.ok(text.indexOf(`"model"`) < text.indexOf(`"env"`));
    assert.ok(text.indexOf(`"B"`) < text.indexOf(`"A"`));
    assert.equal(statSync(path).mode & 0o777, 0o600);

    // Installing again changes nothing, not even the file's formatting.
    const written = readFileSync(path, "utf8");
    writeFileSync(path, `${written}\n`, { mode: 0o600 });
    await setHooks(["claude"], true);
    assert.equal(readFileSync(path, "utf8"), `${written}\n`);

    // An entry from another build of ours is outdated.
    const doc = JSON.parse(written) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const claudeHarness = HARNESSES.find(({ id }) => id === "claude");
    assert.ok(claudeHarness);
    const command = hookCommand(claudeHarness, HOOK_BINARY);
    for (const [event, groups] of Object.entries(doc.hooks)) {
      const kept = groups.filter(
        (group) => !group.hooks.some((hook) => hook.command === command),
      );
      if (kept.length === 0) delete doc.hooks[event];
      else doc.hooks[event] = kept;
    }
    doc.hooks.Stop?.push({
      hooks: [
        {
          // @ts-expect-error: a handler as an older build wrote it
          type: "command",
          command: "/old/smd agents event --harness claude",
        },
      ],
    });
    writeFileSync(path, JSON.stringify(doc, null, 2));
    assert.equal((await statusOf("claude"))?.hooks, "outdated");

    await setHooks(["claude"], false);
    assert.deepEqual(
      JSON.parse(readFileSync(path, "utf8")),
      JSON.parse(original),
    );
  });

  // The hash Codex itself reports (app-server hooks/list) for these
  // entries, so a change to either side's normalization shows up here.
  it("hashes an entry as Codex does", () => {
    const command = "'/tmp/smtest/smd' agents event --harness codex";
    assert.equal(
      codexHookHash({ event: "PostToolUse", async: true }, command),
      "sha256:8a36bd1d01af3a0e74184d4f094708966f0bb85db44998fc5bc0963c122ecec6",
    );
    assert.equal(
      codexHookHash({ event: "Stop" }, command),
      "sha256:0ab8b4a5da8de20af7339c783893a146bb80e9389c6237abde37015a9b31c840",
    );
  });

  it("reads Codex's trust, and removes a hooks file it emptied", async () => {
    const dir = scratch();
    box = sandbox({ env: { CODEX_HOME: dir } });
    await setHooks(["codex"], true);
    assert.equal((await statusOf("codex"))?.trusted, false);
    const codex = HARNESSES.find(({ id }) => id === "codex");
    assert.ok(codex);
    const keyPath = realpathSync(join(dir, "hooks.json"));
    writeFileSync(
      join(dir, "config.toml"),
      codex.hooks
        .map(
          (spec) =>
            `[hooks.state."${keyPath}:${snakeCase(spec.event)}:0:0"]\ntrusted_hash = "${codexHookHash(spec, hookCommand(codex, HOOK_BINARY))}"\n`,
        )
        .join("\n"),
    );
    assert.equal((await statusOf("codex"))?.trusted, true);

    await setHooks(["codex"], false);
    assert.equal(existsSync(join(dir, "hooks.json")), false);
    // Removing what isn't there writes nothing.
    await setHooks(["codex"], false);
    assert.equal(existsSync(join(dir, "hooks.json")), false);
  });

  it("writes through a symlink, and refuses a malformed file", async () => {
    const dir = scratch();
    box = sandbox({ env: { CODEX_HOME: dir } });
    const dotfiles = join(scratch(), "hooks.json");
    writeFileSync(dotfiles, "{}\n", { mode: 0o644 });
    const link = join(dir, "hooks.json");
    symlinkSync(dotfiles, link);
    for (const install of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop -- the uninstall undoes the install
      await setHooks(["codex"], install);
      assert.ok(lstatSync(link).isSymbolicLink());
    }
    assert.equal(readFileSync(dotfiles, "utf8").trim(), "{}");

    unlinkSync(link);
    const malformed = `{"hooks":{"Stop":{"command":"say done"}}}`;
    writeFileSync(link, malformed);
    const refused = (await setHooks(["codex"], true)) as { ok?: boolean };
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(link, "utf8"), malformed);
  });

  it("writes through a dangling symlink", async () => {
    const dir = scratch();
    box = sandbox({ env: { CODEX_HOME: dir } });
    const target = join(scratch(), "dotfiles", "hooks.json");
    mkdirSync(dirname(target), { recursive: true });
    const link = join(dir, "hooks.json");
    symlinkSync(target, link);
    await setHooks(["codex"], true);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal((await statusOf("codex"))?.hooks, "installed");
  });

  it("refuses a harness it doesn't know, as usage", async () => {
    box = sandbox();
    assert.deepEqual(await setHooks(["pi"], true), {
      ok: false,
      error: 'Unknown harness "pi". Known: claude, codex.',
    });
  });
});
