// The guide's side of the agents (Agents.guide): what the harness is
// told, the folder it starts in, and the command line that opens it on
// a guide session with `sm guide mcp` as its tools.
import type { GuideHarness } from "@shigomori/contracts/modules/guide";
import type { ShellSyntax } from "@shigomori/contracts/schemas";
import { typedLines } from "@shigomori/contracts/typedLines";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { linkFolder, mtimeOf } from "./entries.ts";
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
const SOURCE_URL = `https://github.com/${APP_REPO}`;

// Where the terminal `sm` looks for its data dir first.
const DATA_DIR_ENV = "SHIGOMORI_DATA_DIR";

// A TOML basic string, which a JSON string is.
const toml = (text: string) => JSON.stringify(text);

// A TOML literal string, which takes no escapes. Text with three quotes
// in a row has no such form.
const tomlLiteral = (text: string) =>
  text.includes("'") ? `'''${text}'''` : `'${text}'`;

// What the guide's line does differently in each syntax a terminal's
// shell reads. The differences are the PowerShell program's, and syntax
// stands in for it: PowerShell before 7.3 (Windows PowerShell 5.1
// among them), and any PowerShell handing arguments to a batch file,
// drops the `"` inside a program's argument, and Windows PowerShell has
// no `&&` and finds no relative path under a folder whose name has
// brackets.
const BY_SYNTAX: Readonly<
  Record<
    ShellSyntax,
    {
      // A TOML string as codex's `-c` takes it.
      readonly tomlString: (text: string) => string;
      // Whether claude's MCP config goes in a file in the guide's
      // folder, which the line names, rather than in the line.
      readonly configInFile: boolean;
      // Whether the engine, rather than the line, looks for `source`
      // and clears `source.partial` before the clone.
      readonly checksSource: boolean;
      // The line that runs `clone` into `source.partial` in `folder`,
      // and makes it `source`.
      readonly clone: (clone: string, folder: string) => string;
    }
  >
> = {
  posix: {
    tomlString: toml,
    configInFile: false,
    checksSource: false,
    clone: (clone) =>
      `[ -d source ] || { rm -rf source.partial && ${clone} && mv source.partial source; }`,
  },
  powershell: {
    tomlString: tomlLiteral,
    configInFile: true,
    checksSource: true,
    clone: (clone, folder) =>
      `${clone}; Rename-Item -LiteralPath ${typedLines.powershell.path(`${folder}/source.partial`)} -NewName source -ErrorAction Ignore`,
  },
};

// The files in the guide's folder a line gives claude its MCP config in
// (configInFile), read as claude starts. One per session, so two guides
// started together each read their own.
const GUIDE_MCP_CONFIG_FILE = /^mcp-.+\.json$/;

// A day is long past any claude's start, and leaves the folder a day's
// configs at most.
const DAY_MS = 24 * 60 * 60 * 1000;

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
const guideMcpConfig = ({ sm, dataDir, session }: GuideServer) =>
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
// the user must do themselves. `configFile` is the file in the guide's
// folder the line reads.
const guideArgs = (
  syntax: ShellSyntax,
  input: GuideServer & { readonly harness: GuideHarness },
): {
  readonly args: ReadonlyArray<string>;
  readonly configFile:
    | { readonly name: string; readonly content: string }
    | undefined;
} => {
  const { sm, dataDir, session } = input;
  const { tomlString, configInFile } = BY_SYNTAX[syntax];
  switch (input.harness) {
    case "claude": {
      const config = guideMcpConfig(input);
      const configFile = configInFile
        ? { name: `mcp-${session}.json`, content: config }
        : undefined;
      return {
        args: [
          "--mcp-config",
          configFile?.name ?? config,
          "--append-system-prompt",
          GUIDE_SYSTEM_PROMPT,
          "--allowedTools",
          `mcp__${SERVER}`,
        ],
        configFile,
      };
    }
    case "codex":
      return {
        args: [
          `developer_instructions=${tomlString(GUIDE_SYSTEM_PROMPT)}`,
          `mcp_servers.${SERVER}.command=${tomlString(sm)}`,
          `mcp_servers.${SERVER}.args=[${serverArgs(session).map(tomlString).join(", ")}]`,
          `mcp_servers.${SERVER}.env={ ${DATA_DIR_ENV} = ${tomlString(dataDir)} }`,
          `mcp_servers.${SERVER}.default_tools_approval_mode=${tomlString("approve")}`,
        ].flatMap((item) => ["-c", item]),
        configFile: undefined,
      };
  }
};

// The harness's arguments, the line typing them (a word of letters,
// digits, `_` and `-` left bare), and the file it reads, if any.
export const guideCommand = (
  syntax: ShellSyntax,
  input: GuideServer & { readonly harness: GuideHarness },
) => {
  const { args, configFile } = guideArgs(syntax, input);
  const { quote } = typedLines[syntax];
  const words = args.map((arg) => (/^[\w-]+$/.test(arg) ? arg : quote(arg)));
  return {
    args,
    line: [input.harness, ...words].join(" "),
    configFile,
  };
};

// Where the agent a guide opens reads the app's source: a release's tag,
// cloned from GitHub, or a dev build's own checkout.
export type GuideSource =
  | { readonly tag: string }
  | { readonly checkout: string };

// Lays out the guide's folder: its instructions, `source` as the guide
// wants it, and the line's config file, if any. Answers what the
// terminal runs before the harness: the release's clone into `source`
// unless it is there, in the terminal where its progress shows. The
// agent starts either way.
export const writeGuideFolder = Effect.fnUntraced(function* (input: {
  readonly folder: string;
  readonly syntax: ShellSyntax;
  readonly source: GuideSource;
  readonly configFile:
    | { readonly name: string; readonly content: string }
    | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { folder, syntax, configFile } = input;
  const source = path.join(folder, "source");
  // What `source` is to hold, and where the agent reads it when it
  // doesn't.
  const { wanted, sourceUrl, link } =
    "tag" in input.source
      ? {
          wanted: input.source.tag,
          sourceUrl: `${SOURCE_URL}/tree/${input.source.tag}`,
          link: undefined,
        }
      : {
          wanted: input.source.checkout,
          sourceUrl: input.source.checkout,
          link: input.source.checkout,
        };
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(
    path.join(folder, "AGENTS.md"),
    guideInstructions(sourceUrl),
  );
  yield* fs.writeFileString(path.join(folder, "CLAUDE.md"), "@AGENTS.md\n");
  // `source-tag` names the tag `source` holds.
  const tagFile = path.join(folder, "source-tag");
  const held = yield* fs
    .readFileString(tagFile)
    .pipe(Effect.orElseSucceed(() => ""));
  if (held.trim() !== wanted) {
    yield* fs.remove(source, { recursive: true, force: true });
    if (link !== undefined) yield* linkFolder(link, source);
    yield* fs.writeFileString(tagFile, `${wanted}\n`);
  }
  if (configFile !== undefined) {
    // A guide started alongside may remove one first.
    const now = yield* Clock.currentTimeMillis;
    for (const name of yield* fs.readDirectory(folder)) {
      if (!GUIDE_MCP_CONFIG_FILE.test(name)) continue;
      const file = path.join(folder, name);
      yield* fs.stat(file).pipe(
        Effect.flatMap((info) =>
          now - mtimeOf(info) > DAY_MS
            ? fs.remove(file, { force: true })
            : Effect.void,
        ),
        Effect.ignore,
      );
    }
    yield* fs.writeFileString(
      path.join(folder, configFile.name),
      configFile.content,
    );
  }
  if (!("tag" in input.source)) return "";
  const { checksSource, clone } = BY_SYNTAX[syntax];
  if (checksSource) {
    if (yield* fs.exists(source)) return "";
    yield* fs.remove(path.join(folder, "source.partial"), {
      recursive: true,
      force: true,
    });
  }
  const { quote } = typedLines[syntax];
  return `${clone(
    `git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${quote(input.source.tag)} ${SOURCE_URL}.git source.partial`,
    folder,
  )}; `;
});

// The guide folder's AGENTS.md (Codex reads it, and Claude Code through
// a CLAUDE.md naming it).
const guideInstructions = (
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
