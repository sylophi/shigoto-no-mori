import { Schema } from "effect";
import { z } from "zod";

// One bound for every port number the app models: the forward engine's
// payloads, a worktree's user-added ports, the local-port preference.
const PORT_MIN = 1;
const PORT_MAX = 65535;

export const PortNumberSchema = Schema.Int.check(
  Schema.isBetween({ minimum: PORT_MIN, maximum: PORT_MAX }),
);

// The zod form, for the zod schemas that still embed a port (config.ts's
// local-port preference, the forward and portForward contracts): a zod
// object cannot hold a Schema field. Phase 4 waves 2 and 3 remove this.
export const PortNumberZod = z.number().int().min(PORT_MIN).max(PORT_MAX);

export const PORT_LABEL_MAX = 32;
// Cap on user-added ports per worktree. Well above what a dev setup
// needs (a web server, an api, a db, a storybook) and small enough that
// the section stays a glanceable list rather than a table.
export const MAX_CUSTOM_PORTS = 16;

// A port the user added to a worktree beside what port-pool allocates
// (an api the dev script starts on a fixed number, a storybook), kept
// in the worktree's data file. The label is optional: an unlabeled
// entry shows as its number.
export const CustomPortSchema = Schema.Struct({
  port: PortNumberSchema,
  label: Schema.optional(
    Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(PORT_LABEL_MAX)),
  ),
});
export type CustomPort = typeof CustomPortSchema.Type;

// The zod form of CustomPortSchema, for config.ts's worktree data
// schema that still embeds it. Phase 4 wave 2 removes this.
export const CustomPortZod = z.object({
  port: PortNumberZod,
  label: z.string().trim().min(1).max(PORT_LABEL_MAX).optional(),
});

// Where a listed port came from: port-pool's allocation for the
// worktree directory (named after the entry in the project's
// port-pool.config.json), or the worktree data file.
const WorktreePortSourceSchema = Schema.Literals(["pool", "custom"]);

// One row of a worktree's port list as the host reports it: the merged
// pool + custom set, each probed once on the host's own loopback so the
// UI can show which ones have a server behind them right now.
const WorktreePortSchema = Schema.Struct({
  port: PortNumberSchema,
  label: Schema.optional(Schema.String),
  source: WorktreePortSourceSchema,
  listening: Schema.Boolean,
});
export type WorktreePort = typeof WorktreePortSchema.Type;

export const WorktreePortsResultSchema = Schema.Struct({
  ports: Schema.Array(WorktreePortSchema),
});
export type WorktreePortsResult = typeof WorktreePortsResultSchema.Type;

// A port typed into a field: the number in range, or undefined for
// anything else (empty, junk, out of range).
const isPortNumber = Schema.is(PortNumberSchema);

export function parsePortNumber(raw: string): number | undefined {
  const parsed = Number(raw);
  return isPortNumber(parsed) ? parsed : undefined;
}

// Keystroke filter for a port field: digits only, so the parse above
// only ever sees a number or nothing.
export function digitsOnly(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}
