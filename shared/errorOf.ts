// Reading an error without knowing its class: the message, the tag,
// a field, a code. Effect-free on purpose, so the wire codec
// (shared/ipc/wireError.ts) and the frame schemas can use these from
// the hub Worker's compile, which must not load the effect package.
// shared/errors.ts re-exports them beside the typed error classes.

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The tag of a typed error, whichever side of a wire it is on: an
// Effect tagged error minted in-process, or the WireError a transport
// rebuilt from a res frame. undefined for a plain Error.
export function errorTagOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return undefined;
  }
  return typeof error._tag === "string" ? error._tag : undefined;
}

// A field of a typed error by name, for a reader that only knows the
// tag (the renderer behind a wire, where the class is not in scope).
export function errorFieldOf(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

// The machine-readable code an error carries, when it has one (a
// ControlError, a Node errno). What the control wire sends beside the
// message so the CLI keys on the code and not on the prose.
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
