// Schema-derived stub values for the OS-bound contract surface the web
// client cannot serve. The bridge answers an eligible unhandled channel
// (see loopback.ts for the fail-closed eligibility rule) with a benign
// default derived from the invoke's OUTPUT schema, so a shared
// component that brushes an OS-only read renders an empty state instead
// of throwing.
//
// The walker is least-privileged: by default it only produces
// STRUCTURAL emptiness (undefined, false, 0, "", null, [], {} and
// objects recursively built from those). It refuses to fabricate a
// value that asserts something, which means any enum, union or literal
// arm (a first arm is affirmative-biased: a status enum would stub to
// its "ok"-like value) and any bounded string or number a plain empty
// cannot satisfy. A schema that cannot be met structurally yields
// NO_STRUCTURAL_STUB and the channel rejects instead, so a future
// permission-shaped query can never silently answer "granted". Only a
// channel on the bridge's explicit allowlist (where the arm choice has
// been judged harmless) may pass fabricateArms to opt back in.
import { z } from "zod";

// Distinct from every legal stub value (undefined included), so the
// caller can tell "no safe stub exists" from "the stub is undefined".
export const NO_STRUCTURAL_STUB = Symbol("no structural stub");

// Candidate scalars tried against the schema first, cheapest first.
// This resolves most read-shaped defs outright: void and unknown accept
// undefined, booleans accept false, counts accept 0, ids accept "",
// nullables accept null, lists accept [] and loose objects and records
// accept {}.
const SCALAR_CANDIDATES: readonly unknown[] = [undefined, false, 0, "", null];

export type StubOptions = {
  // Permit fabricated values (enum, union and literal arms, bounded
  // strings and numbers). Only the bridge allowlist path sets this.
  fabricateArms: boolean;
};

export function stubValueFor(
  schema: z.ZodType,
  opts: StubOptions,
): unknown | typeof NO_STRUCTURAL_STUB {
  for (const candidate of SCALAR_CANDIDATES) {
    const result = schema.safeParse(candidate);
    if (result.success) return result.data;
  }
  const asArray = schema.safeParse([]);
  if (asArray.success) return asArray.data;
  const asObject = schema.safeParse({});
  if (asObject.success) return asObject.data;

  // Objects with required members are built recursively from the same
  // rules, so a nested enum still blocks the whole stub unless
  // fabrication was allowed.
  if (schema instanceof z.ZodObject) {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries<z.ZodType>(schema.shape)) {
      const value = stubValueFor(field, opts);
      if (value === NO_STRUCTURAL_STUB) return NO_STRUCTURAL_STUB;
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  if (!opts.fabricateArms) return NO_STRUCTURAL_STUB;

  // Fabrication, allowlist-only: literals and enums pin or pick a
  // value, a union (discriminated included) takes its first arm, and
  // bounded scalars get an obviously synthetic placeholder.
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodUnion) {
    const first = (schema.options as readonly z.ZodType[])[0];
    return first === undefined ? NO_STRUCTURAL_STUB : stubValueFor(first, opts);
  }
  if (schema instanceof z.ZodString) return "unavailable";
  if (schema instanceof z.ZodNumber) return 0;
  return NO_STRUCTURAL_STUB;
}
