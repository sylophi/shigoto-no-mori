// An execFile rejection, sorted the way the process runners (git in
// host/lib/git/core.ts, gh in host/lib/githubCli/exec.ts) report it.
// Each runner turns the kind into its own tagged errors.

// execFile's rejection, as the promisified form hands it over.
interface ExecFileFailure {
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
}

export type ExecFailure =
  // Node killed the child once its output passed maxBuffer. `stdout` is
  // a prefix of the real output, never the whole of it.
  | { kind: "truncated"; stdout: string }
  // The program ran and failed: a non-zero exit, or a kill by signal
  // (exitCode null). `killed` marks Node's own kill, the timeout. A
  // cancelled run's rejection is never read, its fiber is interrupted.
  | {
      kind: "exit";
      exitCode: number | null;
      killed: boolean;
      stdout: string;
      stderr: string;
    }
  // The program never ran: not on the PATH, a cwd that is not there.
  // `code` is Node's errno.
  | { kind: "spawn"; code: string | null; message: string };

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

// A numeric `code` is the exit status. A string one is an errno from
// the spawn or Node's maxBuffer kill. Neither with a signal set is a
// kill.
export function classifyExecFailure(err: unknown): ExecFailure {
  const failure =
    typeof err === "object" && err !== null ? (err as ExecFileFailure) : {};
  const { code, signal, killed, stdout, stderr } = failure;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind: "truncated", stdout: asText(stdout) };
  }
  if (typeof code === "number" || typeof signal === "string") {
    return {
      kind: "exit",
      exitCode: typeof code === "number" ? code : null,
      killed: killed === true,
      stdout: asText(stdout),
      stderr: asText(stderr),
    };
  }
  return {
    kind: "spawn",
    code: typeof code === "string" ? code : null,
    message:
      typeof failure.message === "string" ? failure.message : String(err),
  };
}
