import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The agent sessions bound to worktrees (Agents.ts), in place of the
// agent-working mark: a worktree's working session is what the shelf
// takes now. A session is bound to one worktree at a time, and a
// worktree lists its sessions in the order they were bound (rowid).
// `waits` is the JSON array of the permission prompts it waits on.
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
});
