// The guide's launch line (agentGuide.ts): a shell reads it back into
// the harness's arguments as given, a prompt with quotes and a
// newline in it included (the app's opening, or the lab's question), with the MCP server that finds this app's
// data dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { guideCommand } from "../src/agentGuide.ts";

const PROMPT = `how do I "mirror" it's worktree?\n$(rm -rf ~)`;

const launch = {
  sm: "/Applications/Shigoto no Mori.app/Contents/Resources/sm",
  dataDir: "/Users/someone/.sm",
  session: "a".repeat(43),
  prompt: PROMPT,
};

// The words a shell makes of the line, its first one swapped for printf.
const wordsOf = (line: string) =>
  execFileSync(
    "/bin/sh",
    ["-c", `printf '%s\\0' ${line.slice(line.indexOf(" ") + 1)}`],
    { encoding: "utf8" },
  )
    .split("\0")
    .slice(0, -1);

describe("guideCommand", () => {
  it("opens Claude Code on the prompt, with the guide's server and its tools allowed", () => {
    const line = guideCommand({ harness: "claude", ...launch });
    assert.ok(line.startsWith("claude "));
    const words = wordsOf(line);
    assert.equal(words.at(-1), PROMPT);
    assert.equal(words.at(-2), "--");
    assert.deepEqual(words.slice(words.indexOf("--allowedTools"), -2), [
      "--allowedTools",
      "mcp__shigomori",
    ]);
    const config = JSON.parse(words[words.indexOf("--mcp-config") + 1] ?? "");
    assert.deepEqual(config, {
      mcpServers: {
        shigomori: {
          command: launch.sm,
          args: ["guide", "mcp", "--session", launch.session],
          env: { SHIGOMORI_DATA_DIR: launch.dataDir },
        },
      },
    });
  });

  it("opens Codex on the prompt, with the guide's server approved", () => {
    const line = guideCommand({ harness: "codex", ...launch });
    assert.ok(line.startsWith("codex "));
    const words = wordsOf(line);
    assert.equal(words.at(-1), PROMPT);
    const settings = words.filter((_, i) => words[i - 1] === "-c");
    assert.deepEqual(settings, [
      `mcp_servers.shigomori.command="${launch.sm}"`,
      `mcp_servers.shigomori.args=["guide", "mcp", "--session", "${launch.session}"]`,
      `mcp_servers.shigomori.env={ SHIGOMORI_DATA_DIR = "${launch.dataDir}" }`,
      'mcp_servers.shigomori.default_tools_approval_mode="approve"',
    ]);
  });
});
