// The guide's side of the agents (Agents.guide): what the harness is
// told, and the command line that opens it on a guide session with
// `sm guide mcp` as its tools.
import { shellQuote } from "./Lifecycle.ts";

export type GuideHarness = "claude" | "codex";

// The MCP server's name in the harness, which its tools are named under.
const SERVER = "shigomori";

export const SOURCE_REPO = "https://github.com/sylophi/shigoto-no-mori.git";

// Where the terminal `sm` looks for its data dir first.
const DATA_DIR_ENV = "SHIGOMORI_DATA_DIR";

// A TOML basic string, which a JSON string is.
const toml = (text: string) => JSON.stringify(text);

// The harness on `question`, its tools `sm guide mcp` on `session`,
// allowed without asking each time: the app turns away what the user
// must do themselves. The server is told the app's data dir, where it
// finds the app, whatever the terminal's environment says.
export const guideCommand = (input: {
  readonly harness: GuideHarness;
  readonly sm: string;
  readonly dataDir: string;
  readonly session: string;
  readonly question: string;
}) => {
  const { harness, sm, dataDir, session, question } = input;
  const args = ["guide", "mcp", "--session", session];
  switch (harness) {
    case "claude": {
      const config = JSON.stringify({
        mcpServers: {
          [SERVER]: { command: sm, args, env: { [DATA_DIR_ENV]: dataDir } },
        },
      });
      return `claude --mcp-config ${shellQuote(config)} --allowedTools mcp__${SERVER} -- ${shellQuote(question)}`;
    }
    case "codex":
      return [
        "codex",
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
        "--",
        shellQuote(question),
      ].join(" ");
  }
};

// Clones the release's source into `source` unless it is there, in the
// terminal where its progress shows. The agent starts either way.
export const cloneSourceCommand = (tag: string) =>
  `[ -d source ] || { rm -rf source.partial && git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${shellQuote(tag)} ${SOURCE_REPO} source.partial && mv source.partial source; }`;

// The guide folder's AGENTS.md (Codex reads it, and Claude Code through
// a CLAUDE.md naming it).
export const guideInstructions = (
  sourceUrl: string,
) => `# Guiding a Shigoto no Mori user

This folder is Shigoto no Mori's own guide folder, which the app writes.

The user asked how to do something in Shigoto no Mori, a desktop app
for working on many git worktrees at once. Their question is your first
message. The app's window is open beside this terminal, and the
\`${SERVER}\` tools drive it. Show them the answer in the app.

## The tools

- \`look\`: the window's accessibility tree. Every control has a ref.
- \`screenshot\`: saves the window as a PNG and answers its path. Open
  it to see the window.
- \`point\`: highlights a ref in the window, with one sentence beside it.
- \`click\`, \`fill\`, \`press\`: act in the window, as the user would.
- \`navigate\`: opens a page by its route (\`/settings\`, \`/live\`,
  \`/devices/<id>/projects/<id>/worktrees/<id>\`). Every answer names
  the route the window shows.
- \`clear\`: removes the highlight.

## How to guide

1. Learn how the app does it before you act. \`source/\` is the
   app's source at the version the user runs (\`README.md\`,
   \`PRODUCT.md\`, the views in \`packages/ui/src/views\`, the routes in
   \`app/renderer/router.tsx\`). If \`source/\` is missing, read it at
   ${sourceUrl}.
2. Go step by step: \`look\`, then \`point\` at the control for the
   step and say what it does, then click it or let the user. Say each
   step in a line here too.
3. Do it in the app. Don't do it behind the app's back with \`sm\`,
   git or by editing files: the user wants to learn the app.
4. Some controls are the user's alone: anything that deletes, removes,
   discards or signs out, and every terminal. The app refuses your
   clicks and keys there. Point at the control and let them decide.
5. When you are done, \`clear\` and say what they can do next.

Read the source, but never change it.
`;
