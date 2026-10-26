import * as Schema from "effect/Schema";
import { push, defineContract, invoke, Remote } from "../contract.ts";
import { harnessLabel, KNOWN_HARNESS_IDS } from "../harnesses.ts";
import { VoidSchema } from "../schemas/index.ts";
import { TerminalIdSchema } from "../schemas/launchers.ts";
import { strict } from "../schemas/strict.ts";

// A user's own agent, opened from the Help menu, drives the window it was
// opened from: `sm guide mcp` calls the host, which passes the call to its
// shell, which drives the window.

const GuideHarnessSchema = Schema.Literals(KNOWN_HARNESS_IDS);
export type GuideHarness = typeof GuideHarnessSchema.Type;
export const isGuideHarness = Schema.is(GuideHarnessSchema);

// What the guide is for, as the sidebar's question mark and its menu
// say it, and the Help menu's item for a harness.
export const GUIDE_QUESTION = "Ask a question about the app";
export const askAboutTheApp = (harness: GuideHarness): string =>
  `Ask ${harnessLabel(harness)} about the app`;

// A terminal app the guide can open in. While the `terminal` setting is
// the app's own, the guide's menus ask which: the app's drawer belongs to
// a worktree, and the agent would be working on the app it runs in.
const GuideTerminalSchema = Schema.Struct({
  id: TerminalIdSchema,
  label: Schema.String,
});

// What the guide's menus offer: the harnesses installed here, and the
// terminals to ask between, none when the setting names one.
export const GuideChoicesSchema = Schema.Struct({
  harnesses: Schema.Array(GuideHarnessSchema),
  terminals: Schema.Array(GuideTerminalSchema),
});
export type GuideChoices = typeof GuideChoicesSchema.Type;

// What the menus draw from the choices, to tell a change by.
export const guideChoicesKey = ({ harnesses, terminals }: GuideChoices) =>
  `${harnesses.join()};${terminals.map(({ id }) => id).join()}`;

// A guide to open, in the terminal picked from the menu, else the
// setting's.
const GuideStartFields = {
  harness: GuideHarnessSchema,
  terminal: Schema.optional(TerminalIdSchema),
};
export const GuideStartSchema = strict(Schema.Struct(GuideStartFields));
export type GuideStart = typeof GuideStartSchema.Type;

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
  invoke("start", GuideStartSchema, VoidSchema),
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
    ...GuideStartFields,
  }),
);
