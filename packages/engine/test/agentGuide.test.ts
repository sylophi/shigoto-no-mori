// The guide's launch line (agentGuide.ts): a shell reads it back into
// the harness's arguments as given, the guide's role as the harness's
// system-level instructions and no message of the user's, with the MCP
// server that finds this app's data dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
import { GUIDE_SYSTEM_PROMPT, guideCommand } from "../src/agentGuide.ts";

const launch = {
  sm: "/Applications/Shigoto no Mori.app/Contents/Resources/sm",
  dataDir: "/Users/someone/.sm",
  session: "a".repeat(43),
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
  it("opens Claude Code idle, its role appended to the system prompt, with the guide's server and its tools allowed", () => {
    const line = guideCommand({ harness: "claude", ...launch });
    assert.ok(line.startsWith("claude "));
    const words = wordsOf(line);
    assert.equal(
      words[words.indexOf("--append-system-prompt") + 1],
      GUIDE_SYSTEM_PROMPT,
    );
    // Every word is a flag's or its value: no message of the user's.
    assert.deepEqual(words.slice(words.indexOf("--allowedTools")), [
      "--allowedTools",
      "mcp__shigomori",
    ]);
    assert.equal(words.length, 6);
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

  it("opens Codex idle, its role as developer instructions, with the guide's server approved", () => {
    const line = guideCommand({ harness: "codex", ...launch });
    assert.ok(line.startsWith("codex "));
    const words = wordsOf(line);
    const settings = words.filter((_, i) => words[i - 1] === "-c");
    // Every word is a setting: no message of the user's.
    assert.equal(words.length, settings.length * 2);
    assert.deepEqual(settings, [
      `developer_instructions=${JSON.stringify(GUIDE_SYSTEM_PROMPT)}`,
      `mcp_servers.shigomori.command="${launch.sm}"`,
      `mcp_servers.shigomori.args=["guide", "mcp", "--session", "${launch.session}"]`,
      `mcp_servers.shigomori.env={ SHIGOMORI_DATA_DIR = "${launch.dataDir}" }`,
      'mcp_servers.shigomori.default_tools_approval_mode="approve"',
    ]);
  });
});
