import * as Schema from "effect/Schema";
import { push, defineContract, invoke, Remote } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// A user's own agent, opened from the Help menu, drives the window it was
// opened from: `sm guide mcp` calls the host, which passes the call to its
// shell, which drives the window.

export const GuideHarnessSchema = Schema.Literals(["claude", "codex"]);
export type GuideHarness = typeof GuideHarnessSchema.Type;
export const isGuideHarness = Schema.is(GuideHarnessSchema);

export const GUIDE_HARNESS_LABELS: Record<GuideHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const GuideRefSchema = Schema.Int.check(Schema.isGreaterThan(0));

const GuideRouteSchema = Schema.String.check(
  Schema.isBetweenLength(1, 2048),
  Schema.isStartingWith("/"),
);

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

// Also each action's MCP tool parameters.
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
  // Not a tool: what `sm guide mcp` sends as it stops.
  Schema.TaggedStruct("end", {}),
]);
export type GuideAction = typeof GuideActionSchema.Type;

const GuideSessionSchema = Schema.String.check(Schema.isBetweenLength(16, 128));

export const GuideDrivePayloadSchema = strict(
  Schema.Struct({ session: GuideSessionSchema, action: GuideActionSchema }),
);
export type GuideDrivePayload = typeof GuideDrivePayloadSchema.Type;

export const GuideReplySchema = strict(
  Schema.Struct({
    route: Schema.String,
    tree: Schema.optional(Schema.String),
    png: Schema.optional(Schema.String),
  }),
);
export type GuideReply = typeof GuideReplySchema.Type;

// `seq` moves with each point, so the window finds the target again.
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

export const guideContract = defineContract(
  "guide",
  "client",
  // A window already guided is guided by the new session alone.
  invoke(
    "start",
    strict(Schema.Struct({ harness: GuideHarnessSchema })),
    VoidSchema,
  ),
  invoke("read", VoidSchema, Schema.NullOr(GuideStateSchema)),
  // Its session's token is refused from then.
  invoke("stop", VoidSchema, VoidSchema),
  push("changed", Schema.NullOr(GuideStateSchema)),
);

// Loopback only, and kept out of allContractModules, so no window's api
// carries them.
export const guideDriveContract = defineContract(
  "guideDrive",
  "host",
  invoke("drive", GuideDrivePayloadSchema, GuideReplySchema),
).annotateRpcs(Remote, false);

export const GuideLaunchSchema = strict(
  Schema.Struct({
    session: GuideSessionSchema,
    harness: GuideHarnessSchema,
  }),
);
