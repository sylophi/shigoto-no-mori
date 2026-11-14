// The guide's side of the agents (Agents.guide): what the harness is
// told, and the command line that opens it on a guide session with
// `sm guide mcp` as its tools.
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import type { ShellSyntax } from "@shigomori/contracts/schemas";
import { typedLines } from "@shigomori/contracts/typedLines";
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

// A TOML literal string, which takes no escapes. Text with three quotes
// in a row has no such form.
const tomlLiteral = (text: string) =>
  text.includes("'") ? `'''${text}'''` : `'${text}'`;

// The file in the guide's folder that PowerShell's line gives claude
// its MCP config in (guideCommand), read as claude starts.
export const GUIDE_MCP_CONFIG = "mcp.json";

// The agent's role, as each harness's system-level instructions: it
// starts idle, and the person types their question.
const GUIDE_SYSTEM_PROMPT =
  "You are helping someone with a question about Shigoto no Mori, the app whose source and documentation are in `source/` here. Answer from the source, `skills/` and the READMEs, and say when the answer is not there. Offer a walkthrough only if asked.";

type GuideServer = {
  readonly sm: string;
  readonly dataDir: string;
  readonly session: string;
};

const serverArgs = (session: string) => ["guide", "mcp", "--session", session];

// claude's MCP config: the server `sm guide mcp` on `session`, told the
// app's data dir, where it finds the app, whatever the terminal's
// environment says.
export const guideMcpConfig = ({ sm, dataDir, session }: GuideServer) =>
  JSON.stringify({
    mcpServers: {
      [SERVER]: {
        command: sm,
        args: serverArgs(session),
        env: { [DATA_DIR_ENV]: dataDir },
      },
    },
  });

// The harness with the guide's role, its tools `sm guide mcp` on
// `session`, allowed without asking each time: the app turns away what
// the user must do themselves. PowerShell before 7.3, and any through a
// batch file, drops the `"` inside a program's argument, so PowerShell's
// line names claude's config by its file and gives codex its strings in
// TOML's single quotes.
export const guideCommand = (
  syntax: ShellSyntax,
  input: GuideServer & { readonly harness: GuideHarness },
) => {
  const { harness, sm, dataDir, session } = input;
  const { quote } = typedLines[syntax];
  const string = syntax === "posix" ? toml : tomlLiteral;
  switch (harness) {
    case "claude": {
      const config =
        syntax === "posix" ? guideMcpConfig(input) : GUIDE_MCP_CONFIG;
      return `claude --mcp-config ${quote(config)} --append-system-prompt ${quote(GUIDE_SYSTEM_PROMPT)} --allowedTools mcp__${SERVER}`;
    }
    case "codex":
      return [
        "codex",
        "-c",
        quote(`developer_instructions=${string(GUIDE_SYSTEM_PROMPT)}`),
        "-c",
        quote(`mcp_servers.${SERVER}.command=${string(sm)}`),
        "-c",
        quote(
          `mcp_servers.${SERVER}.args=[${serverArgs(session).map(string).join(", ")}]`,
        ),
        "-c",
        quote(
          `mcp_servers.${SERVER}.env={ ${DATA_DIR_ENV} = ${string(dataDir)} }`,
        ),
        "-c",
        quote(
          `mcp_servers.${SERVER}.default_tools_approval_mode=${string("approve")}`,
        ),
      ].join(" ");
  }
};

// Clones the release's source into `source` unless it is there, in the
// terminal where its progress shows. The agent starts either way.
// Windows PowerShell has no `&&`, so for PowerShell the engine looks for
// `source` and clears `source.partial` before it types this.
export const cloneSourceCommand = (syntax: ShellSyntax, tag: string) => {
  const clone = `git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${typedLines[syntax].quote(tag)} ${SOURCE_URL}.git source.partial`;
  return syntax === "posix"
    ? `[ -d source ] || { rm -rf source.partial && ${clone} && mv source.partial source; }`
    : `${clone}; Rename-Item -LiteralPath source.partial -NewName source -ErrorAction Ignore`;
};

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
