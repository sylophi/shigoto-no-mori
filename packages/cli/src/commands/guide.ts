// sm guide mcp: the guide's tools, an MCP server over stdio that the app
// hands the agent it opens (the engine's Agents.guide). Each tool is one
// of the guide's actions (contracts' modules/guide.ts), with the
// action's own schema as its parameters, sent to the running app under
// the session the app minted for the window that asked. Only the app
// starts it, so the help leaves it out.
import {
  type GuideAction,
  GuideActionFields,
  GuideReplySchema,
} from "@shigomori/contracts/modules/guide";
import * as Control from "@shigomori/engine/Control";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpServer from "effect/ai/McpServer";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { version } from "../build.ts";

// The app turned an action down, or could not be reached, in its words.
class GuideToolFailed extends Schema.TaggedError<GuideToolFailed>()(
  "GuideToolFailed",
  { message: Schema.String },
) {}

const Reply = Schema.Struct({
  route: Schema.String,
  tree: Schema.optional(Schema.String),
  // A screenshot's PNG file.
  path: Schema.optional(Schema.String),
});

// A tool of an action that takes something, which the action's fields
// describe.
const tool = <Name extends "navigate" | "click" | "fill" | "press" | "point">(
  name: Name,
  description: string,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(GuideActionFields[name]),
    success: Reply,
    failure: GuideToolFailed,
  });

// One that takes nothing: an empty object, which an empty struct does not
// describe to the server.
const bareTool = <Name extends "look" | "screenshot" | "clear">(
  name: Name,
  description: string,
) =>
  Tool.make(name, {
    description,
    parameters: Tool.EmptyParams,
    success: Reply,
    failure: GuideToolFailed,
  });

const Tools = Toolkit.make(
  bareTool(
    "look",
    "The window's accessibility tree: every control on the page, each with the ref the other tools take.",
  )
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  bareTool(
    "screenshot",
    "Saves the window as a PNG and answers its path. Open the file to see the window.",
  )
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  tool(
    "navigate",
    "Opens a page of the app by its route, such as /settings or /live.",
  ),
  tool("click", "Clicks a control by its ref."),
  tool("fill", "Replaces the text of a field by its ref with the given text."),
  tool("press", "Presses a key in the focused control."),
  tool(
    "point",
    "Highlights a control by its ref in the user's window, with one sentence beside it.",
  ),
  bareTool("clear", "Removes the highlight."),
);

const decodeReply = Schema.decodeUnknownEffect(GuideReplySchema);

const handlers = (session: string) =>
  Tools.toLayer(
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The screenshots, gone when the server stops.
      const shots = yield* fs.makeTempDirectoryScoped({ prefix: "sm-guide-" });
      // The agent is gone once its server stops, and so is its session.
      yield* Effect.addFinalizer(() =>
        control
          .call("guideDrive:drive", { session, action: { _tag: "end" } })
          .pipe(Effect.ignore),
      );
      let taken = 0;
      const drive = (action: GuideAction) =>
        control.call("guideDrive:drive", { session, action }).pipe(
          Effect.flatMap(decodeReply),
          Effect.flatMap(({ png, ...reply }) =>
            png === undefined
              ? Effect.succeed(reply)
              : Effect.gen(function* () {
                  taken += 1;
                  const file = path.join(shots, `window-${taken}.png`);
                  yield* fs.writeFile(file, Buffer.from(png, "base64"));
                  return { ...reply, path: file };
                }),
          ),
          Effect.mapError(
            (error) => new GuideToolFailed({ message: error.message }),
          ),
        );
      return Tools.of({
        look: () => drive({ _tag: "look" }),
        screenshot: () => drive({ _tag: "screenshot" }),
        navigate: (params) => drive({ _tag: "navigate", ...params }),
        click: (params) => drive({ _tag: "click", ...params }),
        fill: (params) => drive({ _tag: "fill", ...params }),
        press: (params) => drive({ _tag: "press", ...params }),
        point: (params) => drive({ _tag: "point", ...params }),
        clear: () => drive({ _tag: "clear" }),
      });
    }),
  );

const server = (session: string) =>
  McpServer.toolkit(Tools).pipe(
    Layer.provide(handlers(session)),
    Layer.provide(
      McpServer.layerStdio({
        name: "shigomori",
        version,
        instructions:
          "These tools drive the user's Shigoto no Mori window, to show them how to do something in the app.",
        protocols: [
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_03_26,
          McpProtocol.v2024_11_05,
        ],
      }),
    ),
  );

const mcp = Command.make(
  "mcp",
  { session: Flag.String("session") },
  ({ session }) =>
    // Served until the agent closes its end, which ends the server by
    // interrupting it: that is how it stops, not a failure.
    Layer.launch(server(session)).pipe(Effect.ignoreCause),
);

export const guideCommand = Command.make("guide").pipe(
  Command.withSubcommands([mcp]),
);
