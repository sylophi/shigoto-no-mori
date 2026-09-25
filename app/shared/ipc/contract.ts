import { z } from "zod";

export type InvokeDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  kind: "invoke";
  channel: string;
  input: I;
  output: O;
  // When true, a successful call counts as the user "using" the project named
  // by the payload's `projectId`, feeding the sidebar usage sorts. Opt-in so
  // reads and view-only preference changes never count; see the IPC registrar.
  tracksProjectUsage?: boolean;
  // Exposure axis, independent of scope. Only invokes tagged true reach
  // a remote websocket peer (main/ipc/register.ts routes them to the ws
  // binding). Left undefined here on purpose: a host-scoped invoke MUST
  // set it explicitly (the socket check enforces this) so a new call
  // can never silently join the remote surface by inheriting a default.
  // Routing treats anything other than exactly true as local-only.
  remote?: boolean;
  // The gate axis for the direct listener. `gated: true` marks a call
  // served to another device only while this host's command-access
  // switch is on (host/socket/server.ts's dispatch gate, the one place
  // that decides). That is every call that changes state the user owns
  // (writes files or config, runs a script, moves a branch or a
  // worktree), and also a few READS kept behind the switch because of
  // what they disclose: fs:listDirectory, fs:scanForGitRepos,
  // fs:isGitRepo, runtime:info, cli:status, cli:shellStatus and the
  // sync reads that name arbitrary host paths (refTips, worktreeFolder,
  // ignoredPaths, hasCommits, landCheck), plus the transfer, stream
  // and mirror-state calls that hand a peer this host's bytes. So the
  // name is the gate, not the effect. `gated: false` is served to every
  // account peer. A call that only refreshes a cache the host keeps for
  // itself (a fetch of remote-tracking refs, a gh listing) is ungated
  // even though it spawns a process and touches the network. Optional
  // in the type because only remote:true host invokes need it (the
  // socket check enforces that a remote invoke classifies itself),
  // while client-scoped and remote:false calls never reach the gate. A
  // remote gated call is something the switch hands to other devices,
  // so it needs a line in the list AcceptCommandsToggle shows the user
  // (GRANTS).
  gated?: boolean;
  // Whether a resolved gated call moved host state a remote viewer
  // caches. Defaults to true for gated invokes: the registrar fires
  // onMutationResolved (the remote-viewer cache ping) unless a def sets
  // exactly false. Set false only on gated channels whose effects
  // are invisible to viewers, like forward's byte shuttling, so an open
  // stream does not re-invalidate a peer's cached view of this host on
  // every poll or send resolution. Orthogonal to `gated`, which is
  // the gate axis and stays true on such channels.
  movesHostState?: boolean;
};

export type BroadcastDef<P extends z.ZodTypeAny = z.ZodTypeAny> = {
  kind: "broadcast";
  channel: string;
  payload: P;
  // Exposure axis for fan-out frames. Only broadcasts tagged true reach
  // remote peers; untagged host broadcasts stay Electron-only, so a
  // future broadcast carrying host-only detail is local by default.
  remote?: boolean;
};

export type CallDef = InvokeDef | BroadcastDef;
export type Contract = Record<string, CallDef>;

// Every contract module tags its calls with the side that serves them.
// "host" calls run on the process that owns the projects, which may
// live on another machine one day. "client" calls stay on the machine
// the window runs on (native dialogs, shell, app menu). Remoteness is
// a property of the transport a scope is wired to, never of the calls
// themselves.
export type ContractScope = "host" | "client";

export type ContractModule<C extends Contract = Contract> = {
  scope: ContractScope;
  calls: C;
};

export const invoke = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  channel: string,
  input: I,
  output: O,
  opts?: {
    tracksProjectUsage?: boolean;
    remote?: boolean;
    gated?: boolean;
    movesHostState?: boolean;
  },
): InvokeDef<I, O> => ({
  kind: "invoke",
  channel,
  input,
  output,
  tracksProjectUsage: opts?.tracksProjectUsage ?? false,
  // Deliberately not defaulted: host-scoped invokes must pass an
  // explicit boolean (enforced by the socket check). Client-scoped
  // invokes never reach the ws binding, so leaving theirs undefined is
  // harmless and routing reads it as local-only.
  remote: opts?.remote,
  // Deliberately not defaulted either: a remote:true host invoke must
  // classify itself (enforced by the socket check) so a new remote call
  // cannot silently join the wire without declaring whether it mutates.
  // Reads and remote:false calls leave it undefined.
  gated: opts?.gated,
  // Undefined means "moves host state" for a gated def. Only an
  // explicit false opts a channel out of the cache ping.
  movesHostState: opts?.movesHostState,
});

export const broadcast = <P extends z.ZodTypeAny>(
  channel: string,
  payload: P,
  opts?: { remote?: boolean },
): BroadcastDef<P> => ({
  kind: "broadcast",
  channel,
  payload,
  remote: opts?.remote,
});

// Scope is deliberately not a type parameter. Today the only consumer
// is the runtime transport lookup in buildApi. A scope brand at the
// type level comes back when a layer needs to branch on it statically.
export const defineContract = <C extends Contract>(
  scope: ContractScope,
  calls: C,
): ContractModule<C> => ({ scope, calls });
