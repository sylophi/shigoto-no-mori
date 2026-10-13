import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { dropsKeys, registryHint, skip } from "./importJson.ts";

// One session as a 2.x registry.json keeps it (the Go sm's agents.go).
const V2SessionSchema = Schema.Struct({
  harness: Schema.String,
  session: Schema.String,
  state: Schema.Literals(["working", "waiting", "idle"]),
  at: Schema.Finite,
  waits: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  need: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeSession = Schema.decodeUnknownOption(V2SessionSchema);

// The agent sessions bound to worktrees (Agents.ts), in place of the
// agent-working mark: a worktree's working session is what the shelf
// takes now. A session is bound to one worktree at a time, and a
// worktree lists its sessions in the order they were bound (rowid).
// `waits` is the JSON array of the permission prompts it waits on. A
// 2.x registry.json keeps them under `agentSessions`, by the worktree's
// id, taken from it here: an entry that doesn't parse is skipped, and a
// session bound twice keeps its first worktree. The move into `wt/`
// re-keys them with their worktree.
export const agentSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_sessions (
    harness TEXT NOT NULL,
    session TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('working', 'waiting', 'idle')),
    at INTEGER NOT NULL,
    waits TEXT NOT NULL,
    title TEXT,
    tool TEXT,
    need TEXT,
    message TEXT,
    PRIMARY KEY (harness, session)
  ) STRICT`;
  yield* sql`DELETE FROM worktree_marks WHERE mark = 'agentWorking'`;
  const bound = yield* registryHint("agentSessions", {});
  const seen = new Set<string>();
  for (const [worktree_id, list] of Object.entries(bound)) {
    for (const entry of list) {
      const found = decodeSession(entry);
      // One that doesn't parse, holds a key this doesn't model, or names
      // a session already bound is left out.
      const key = Option.map(found, (s) => `${s.harness}\0${s.session}`);
      if (
        Option.isNone(found) ||
        Option.isNone(key) ||
        seen.has(key.value) ||
        dropsKeys(V2SessionSchema, entry) ||
        !Number.isInteger(found.value.at)
      ) {
        yield* skip("registry.json", "agentSessions");
        continue;
      }
      seen.add(key.value);
      const s = found.value;
      yield* sql`INSERT INTO agent_sessions ${sql.insert({
        harness: s.harness,
        session: s.session,
        worktree_id,
        state: s.state,
        at: s.at,
        waits: JSON.stringify(s.waits ?? []),
        title: s.title ?? null,
        tool: s.tool ?? null,
        need: s.need ?? null,
        message: s.message ?? null,
      })} ON CONFLICT DO NOTHING`;
    }
  }
});
