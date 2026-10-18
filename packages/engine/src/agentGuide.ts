// The guide's side of the agents (Agents.guide): what the harness is
// told, and the command line that opens it on a guide session with
// `sm guide mcp` as its tools.
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import { APP_REPO } from "./flavor.ts";

// Each harness's tool in the launcher catalog, which says whether its
// CLI is installed.
export const GUIDE_LAUNCHERS: Record<GuideHarness, string> = {
  claude: "claude-code",
  codex: "codex-cli",
};

// The MCP server's name in the harness, which its tools are named under.
const SERVER = "shigomori";

// The app's source on GitHub.
export const SOURCE_URL = `https://github.com/${APP_REPO}`;

// Where the terminal `sm` looks for its data dir first.
const DATA_DIR_ENV = "SHIGOMORI_DATA_DIR";

// A TOML basic string, which a JSON string is.
const toml = (text: string) => JSON.stringify(text);

// The agent's role, as each harness's system-level instructions: it
// starts idle, and the person types their question.
export const GUIDE_SYSTEM_PROMPT =
  "You are helping someone with a question about Shigoto no Mori, the app whose source and documentation are in `source/` here. Answer from the source, `skills/` and the READMEs; say when the answer is not there. Offer a walkthrough only if asked.";

// The harness with the guide's role, its tools `sm guide mcp` on
// `session`, allowed without asking each time: the app turns away what
// the user must do themselves. The server is told the app's data dir,
// where it finds the app, whatever the terminal's environment says.
export const guideCommand = (input: {
  readonly harness: GuideHarness;
  readonly sm: string;
  readonly dataDir: string;
  readonly session: string;
}) => {
  const { harness, sm, dataDir, session } = input;
  const args = ["guide", "mcp", "--session", session];
  switch (harness) {
    case "claude": {
      const config = JSON.stringify({
        mcpServers: {
          [SERVER]: { command: sm, args, env: { [DATA_DIR_ENV]: dataDir } },
        },
      });
      return `claude --mcp-config ${shellQuote(config)} --append-system-prompt ${shellQuote(GUIDE_SYSTEM_PROMPT)} --allowedTools mcp__${SERVER}`;
    }
    case "codex":
      return [
        "codex",
        "-c",
        shellQuote(`developer_instructions=${toml(GUIDE_SYSTEM_PROMPT)}`),
        "-c",
        shellQuote(`mcp_servers.${SERVER}.command=${toml(sm)}`),
        "-c",
        shellQuote(`mcp_servers.${SERVER}.args=[${args.map(toml).join(", ")}]`),
        "-c",
        shellQuote(
          `mcp_servers.${SERVER}.env={ ${DATA_DIR_ENV} = ${toml(dataDir)} }`,
        ),
        "-c",
        shellQuote(
          `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`,
        ),
      ].join(" ");
  }
};

// Clones the release's source into `source` unless it is there, in the
// terminal where its progress shows. The agent starts either way.
export const cloneSourceCommand = (tag: string) =>
  `[ -d source ] || { rm -rf source.partial && git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${shellQuote(tag)} ${SOURCE_URL}.git source.partial && mv source.partial source; }`;

// The guide folder's AGENTS.md (Codex reads it, and Claude Code through
// a CLAUDE.md naming it).
export const guideInstructions = (
  sourceUrl: string,
) => `# Answering a question about Shigoto no Mori

This is Shigoto no Mori's guide folder, which the app writes. \`source/\`
is the app's source at the version the person runs: \`README.md\`,
\`PRODUCT.md\`, \`skills/\`, each folder's README, the views in
\`packages/ui/src/views\` and the routes in \`app/renderer/router.tsx\`.
If \`source/\` is missing, read it at ${sourceUrl}. Read the source, but
never change it.

## The window

The app's window is open beside this terminal, and the \`${SERVER}\`
tools show it to you and act in it:

- \`look\`: the window's accessibility tree. Every control has a ref.
- \`screenshot\`: saves the window as a PNG and answers its path. Open
  it to see the window.
- \`point\`: highlights a ref in the window, with one sentence beside it.
- \`click\`, \`fill\`, \`press\`: act in the window, as the person would.
- \`navigate\`: opens a page by its route (\`/settings\`, \`/live\`,
  \`/devices/<id>/projects/<id>/worktrees/<id>\`). Every answer names
  the route the window shows.
- \`clear\`: removes the highlight.

When the answer is something to do in the app, \`point\` at the control
it starts from. When they ask you to walk them through it:

1. Go step by step: \`look\`, then \`point\` at the control for the
   step and say what it does, then click it or let them. Say each step
   in a line here too.
2. Do it in the app. Don't do it behind the app's back with \`sm\`,
   git or by editing files: they want to learn the app.
3. Some controls are the person's alone: anything that deletes, removes,
   discards or signs out, the switches that let their other devices
   into this machine, what runs code (a script's Run, the launch
   tools, a script's or a launcher's command), and every terminal. The
   app refuses your clicks and keys there. Point at the control and
   let them decide.
4. When you are done, \`clear\` and say what they can do next.
`;
