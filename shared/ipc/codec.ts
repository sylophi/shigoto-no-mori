// A contract schema's codec, and the three calls the wires decode and
// validate with. Every contract input, output and payload is an Effect
// Schema that decodes plain data with no services.
import { Schema } from "effect";

export type AnyCodec = Schema.Codec<unknown, unknown, never, never>;

// The decoded (typed) side of a codec, and the wire (encoded) side.
export type CodecOut<S> = S extends AnyCodec ? S["Type"] : never;
export type CodecIn<S> = S extends AnyCodec ? S["Encoded"] : never;

// An own `__proto__` key, which JSON.parse produces from a document
// that spells one, is never data: a struct copies only its declared
// keys, but a loose document or a record would carry it as an own key,
// and the first copy made by assignment (a cache's structural sharing,
// a spread that writes key by key) would then make its value the
// object's prototype. Dropped before any decode, at every depth. The
// input is copied only where such a key exists.
function dropProtoKeys(root: unknown): unknown {
  // Iterative, with an explicit stack: a hostile frame can nest deeper
  // than the call stack allows, and a walk that overflowed would drop
  // a frame whose call then waits forever.
  const copies = new Map<object, object>();
  const stack: unknown[] = [root];
  const order: object[] = [];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    if (copies.has(value)) continue;
    if (Array.isArray(value)) {
      copies.set(value, value);
      order.push(value);
      for (const item of value) stack.push(item);
      continue;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) continue;
    copies.set(value, value);
    order.push(value);
    for (const item of Object.values(value)) stack.push(item);
  }
  // Children before parents, so a parent sees its children's copies.
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const value = order[i] as object;
    if (Array.isArray(value)) {
      let copy: unknown[] | null = null;
      for (let j = 0; j < value.length; j += 1) {
        const item = replacement(copies, value[j]);
        if (item !== value[j] && copy === null) copy = value.slice();
        if (copy !== null) copy[j] = item;
      }
      if (copy !== null) copies.set(value, copy);
      continue;
    }
    const record = value as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const key of Object.keys(record)) {
      if (key === "__proto__") {
        copy ??= { ...record };
        delete copy[key];
        continue;
      }
      const item = replacement(copies, record[key]);
      if (item !== record[key]) {
        copy ??= { ...record };
        copy[key] = item;
      }
    }
    if (copy !== null) copies.set(value, copy);
  }
  return replacement(copies, root);
}

function replacement(copies: Map<object, object>, value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  return copies.get(value) ?? value;
}

// The walk is a visit of every node, so it runs once per value: a
// value it produced, or a parse of text that cannot spell the key, is
// remembered here and passed through by later decodes of that same
// object (a hub envelope's frame decoded twice). A nested value handed
// on to another decode (a frame's input at the registrar) is walked
// again, since only the value the walk was asked about is remembered.
const protoFree = new WeakSet<object>();

function withoutProtoKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (protoFree.has(value)) return value;
  const clean = dropProtoKeys(value);
  if (typeof clean === "object" && clean !== null) protoFree.add(clean);
  return clean;
}

// JSON.parse for a wire frame. Text that spells neither the key nor a
// unicode escape (which could spell it letter by letter) parses to a
// value with no such key at any depth, so that value skips the walk.
export function parseWireJson(text: string): unknown {
  const raw: unknown = JSON.parse(text);
  if (
    typeof raw === "object" &&
    raw !== null &&
    !text.includes("__proto__") &&
    !text.includes("\\u")
  ) {
    protoFree.add(raw);
  }
  return raw;
}

// Decode or throw: the registrar's unconditional input wall.
export function decodeWith<C extends AnyCodec>(
  codec: C,
  raw: unknown,
): CodecOut<C> {
  return Schema.decodeUnknownSync(codec)(withoutProtoKeys(raw)) as CodecOut<C>;
}

// Validate a value the program already holds in its decoded shape (a
// handler's result under the dev-only output check, a broadcast
// payload at its producer): the type-side check alone, so a transform
// is never run a second time on a decoded value and the wire keeps
// carrying the decoded shape the renderer reads. Contract outputs are
// JSON-shaped by rule (Type equals Encoded); a Schema whose wire form
// differs belongs behind an explicit encode, not here.
export function validateWith(codec: AnyCodec, value: unknown): unknown {
  // The type-side schema alone: a copy holding only the declared keys
  // (a producer's spread of an internal record must not reach a peer),
  // with no transform run, and the issue naming what is wrong when the
  // value does not fit. Built once per codec: the dev-only output check
  // runs it on every handler answer.
  let validate = validators.get(codec);
  if (validate === undefined) {
    validate = Schema.decodeUnknownSync(Schema.toType(codec));
    validators.set(codec, validate);
  }
  return validate(value);
}

const validators = new WeakMap<AnyCodec, (value: unknown) => unknown>();

export type SafeDecode<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: unknown };

// Decode or report: for a reader that drops a malformed value rather
// than failing on it (a push payload, a frame).
export function safeDecodeWith<C extends AnyCodec>(
  codec: C,
  raw: unknown,
): SafeDecode<CodecOut<C>> {
  try {
    const data = Schema.decodeUnknownSync(codec)(
      withoutProtoKeys(raw),
    ) as CodecOut<C>;
    return { success: true, data };
  } catch (error) {
    return { success: false, error };
  }
}
