// The agent hooks' install and the uninstall nuke runs: a hooks file
// keeps everything the user wrote in it, a symlinked one stays a link,
// and the uninstall leaves the file as it was before the install, or
// gone when the install made it.
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Agents from "../src/Agents.ts";
import { HARNESSES, hookCommand } from "../src/agentHooks.ts";
import { HOOK_BINARY, type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// A harness's config dir where the engine looks for it, under the
// sandbox's home.
const configDir = (name: string) => {
  const dir = join(box.home, name);
  mkdirSync(dir);
  return dir;
};

const setHooks = (ids: ReadonlyArray<string>, install: boolean) =>
  box.engine(
    Effect.flatMap(Effect.service(Agents.Agents), (agents) =>
      agents.setHooks(ids, install),
    ),
  );

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
  const path = join(configDir(".claude"), "settings.json");
  writeFileSync(path, original, { mode: 0o600 });
  const claudeHarness = HARNESSES.find(({ id }) => id === "claude");
  assert.ok(claudeHarness);
  const command = hookCommand(claudeHarness, HOOK_BINARY);

  await setHooks(["claude"], true);
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(command));
  assert.ok(text.includes("say done"));
  assert.ok(text.indexOf(`"model"`) < text.indexOf(`"env"`));
  assert.ok(text.indexOf(`"B"`) < text.indexOf(`"A"`));
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // Installing again changes nothing, not even the file's formatting.
  const written = readFileSync(path, "utf8");
  writeFileSync(path, `${written}\n`, { mode: 0o600 });
  await setHooks(["claude"], true);
  assert.equal(readFileSync(path, "utf8"), `${written}\n`);

  // An entry from another build of ours goes with the uninstall too.
  const doc = JSON.parse(written) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
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

  await setHooks(["claude"], false);
  assert.deepEqual(
    JSON.parse(readFileSync(path, "utf8")),
    JSON.parse(original),
  );
});

it("removes a hooks file it emptied", async () => {
  const file = join(configDir(".codex"), "hooks.json");
  await setHooks(["codex"], true);
  assert.ok(existsSync(file));

  await setHooks(["codex"], false);
  assert.equal(existsSync(file), false);
  // Removing what isn't there writes nothing.
  await setHooks(["codex"], false);
  assert.equal(existsSync(file), false);
});

it("writes through a symlink, and refuses a malformed file", async () => {
  const dir = configDir(".codex");
  const dotfiles = join(configDir("dotfiles"), "hooks.json");
  writeFileSync(dotfiles, "{}\n", { mode: 0o644 });
  const link = join(dir, "hooks.json");
  symlinkSync(dotfiles, link);
  for (const install of [true, false]) {
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
  const dir = configDir(".codex");
  const target = join(box.home, "dotfiles", "hooks.json");
  mkdirSync(dirname(target), { recursive: true });
  const link = join(dir, "hooks.json");
  symlinkSync(target, link);
  await setHooks(["codex"], true);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(existsSync(target));
});
