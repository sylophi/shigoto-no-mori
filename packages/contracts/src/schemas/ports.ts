import * as Schema from "effect/Schema";

// One bound for every port number the app models: the forward engine's
// payloads, a worktree's user-added ports, the local-port preference.
export const PortNumberSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);

export const PORT_LABEL_MAX = 32;
// Cap on user-added ports per worktree. Well above what a dev setup
// needs (a web server, an api, a db, a storybook) and small enough that
// the section stays a glanceable list rather than a table.
export const MAX_CUSTOM_PORTS = 16;

// A port the user added to a worktree beside what port-pool allocates
// (an api the dev script starts on a fixed number, a storybook), kept
// in the worktree's data. The label is optional: an unlabeled
// entry shows as its number.
export const CustomPortSchema = Schema.Struct({
  port: PortNumberSchema,
  label: Schema.optional(
    Schema.Trim.check(Schema.isBetweenLength(1, PORT_LABEL_MAX)),
  ),
});
export type CustomPort = typeof CustomPortSchema.Type;

// Where a listed port came from: port-pool's allocation for the
// worktree directory (named after the entry in the project's
// port-pool.config.json), or the worktree's data.
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

const isPortNumber = Schema.is(PortNumberSchema);

// A port typed into a field: the number in range, or undefined for
// anything else (empty, junk, out of range).
export function parsePortNumber(raw: string): number | undefined {
  const port = Number(raw);
  return isPortNumber(port) ? port : undefined;
}

// Keystroke filter for a port field: digits only, so the parse above
// only ever sees a number or nothing.
export function digitsOnly(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}
