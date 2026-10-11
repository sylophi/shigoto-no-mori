import * as Schema from "effect/Schema";
import { push, defineContract, invoke, Remote } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// The guide: a user asks how to do something, and their own agent (Claude
// Code or Codex, in their terminal) shows them in the window they asked
// from. The window asks its shell (guideContract), the shell mints a
// session bound to that window and has the host open the agent
// (session's guideLaunch), and the agent drives the window through
// `sm guide mcp`, whose tools are the actions below: the terminal `sm`
// calls the host (guideDriveContract), the host passes the call on to
// its shell (shellCalls' guide), and the shell drives the window.

// The harnesses the guide opens, by their id in the engine's agent
// hooks table.
const GuideHarnessSchema = Schema.Literals(["claude", "codex"]);
export type GuideHarness = typeof GuideHarnessSchema.Type;
export const isGuideHarness = Schema.is(GuideHarnessSchema);

export const GUIDE_HARNESS_LABELS: Record<GuideHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

// A node of the window's accessibility tree, as `look` names it.
const GuideRefSchema = Schema.Int.check(Schema.isGreaterThan(0));

const GuideRouteSchema = Schema.String.check(
  Schema.isBetweenLength(1, 2048),
  Schema.isStartingWith("/"),
);

// The keys `press` sends: what moves through a form, a list or a dialog.
const GuideKeySchema = Schema.Literals([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
export type GuideKey = typeof GuideKeySchema.Type;

// Each action's own fields, which are also its MCP tool's parameters.
export const GuideActionFields = {
  look: {},
  screenshot: {},
  navigate: { route: GuideRouteSchema },
  click: { ref: GuideRefSchema },
  fill: {
    ref: GuideRefSchema,
    text: Schema.String.check(Schema.isMaxLength(10_000)),
  },
  press: { key: GuideKeySchema },
  point: {
    ref: GuideRefSchema,
    say: Schema.String.check(Schema.isBetweenLength(1, 400)),
  },
  clear: {},
} as const;

const GuideActionSchema = Schema.Union([
  Schema.TaggedStruct("look", GuideActionFields.look),
  Schema.TaggedStruct("screenshot", GuideActionFields.screenshot),
  Schema.TaggedStruct("navigate", GuideActionFields.navigate),
  Schema.TaggedStruct("click", GuideActionFields.click),
  Schema.TaggedStruct("fill", GuideActionFields.fill),
  Schema.TaggedStruct("press", GuideActionFields.press),
  Schema.TaggedStruct("point", GuideActionFields.point),
  Schema.TaggedStruct("clear", GuideActionFields.clear),
  // Not a tool: what `sm guide mcp` sends as it stops, which ends the
  // session.
  Schema.TaggedStruct("end", {}),
]);
export type GuideAction = typeof GuideActionSchema.Type;

const GuideSessionSchema = Schema.String.check(Schema.isBetweenLength(16, 128));

export const GuideDrivePayloadSchema = strict(
  Schema.Struct({ session: GuideSessionSchema, action: GuideActionSchema }),
);
export type GuideDrivePayload = typeof GuideDrivePayloadSchema.Type;

// What an action answers: the page the window shows after it, and for
// `look` the accessibility tree, for `screenshot` the window as a PNG
// (base64).
export const GuideReplySchema = strict(
  Schema.Struct({
    route: Schema.String,
    tree: Schema.optional(Schema.String),
    png: Schema.optional(Schema.String),
  }),
);
export type GuideReply = typeof GuideReplySchema.Type;

// What a window shows while a guide drives it: whose agent, and what it
// points at. The target is marked in the page itself, and `seq` moves
// with each point, so the window finds it again.
const GuideStateSchema = strict(
  Schema.Struct({
    harness: GuideHarnessSchema,
    point: Schema.NullOr(
      strict(
        Schema.Struct({
          say: Schema.String,
          seq: Schema.Int,
        }),
      ),
    ),
  }),
);
export type GuideState = typeof GuideStateSchema.Type;

const GuideQuestionSchema = Schema.String.check(
  Schema.isBetweenLength(1, 2000),
);

// The window's side, served by its shell.
export const guideContract = defineContract(
  "guide",
  "client",
  // Opens the harness on the question, guiding this window. A window
  // already guided is guided by the new session alone.
  invoke(
    "ask",
    strict(
      Schema.Struct({
        harness: GuideHarnessSchema,
        question: GuideQuestionSchema,
      }),
    ),
    VoidSchema,
  ),
  // This window's guide, null when none drives it.
  invoke("read", VoidSchema, Schema.NullOr(GuideStateSchema)),
  // Ends this window's guide: its session's token is refused from then.
  invoke("stop", VoidSchema, VoidSchema),
  // This window's guide moved (to this window alone).
  push("changed", Schema.NullOr(GuideStateSchema)),
);

// The terminal `sm guide mcp`'s calls, served on the loopback only
// (link.ts) and kept out of allContractModules, so no window's api
// carries them.
export const guideDriveContract = defineContract(
  "guideDrive",
  "host",
  invoke("drive", GuideDrivePayloadSchema, GuideReplySchema),
).annotateRpcs(Remote, false);

// What the shell hands the host to open the agent (session's
// guideLaunch).
export const GuideLaunchSchema = strict(
  Schema.Struct({
    session: GuideSessionSchema,
    harness: GuideHarnessSchema,
    question: GuideQuestionSchema,
  }),
);
