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
//
// It walks the schema's SchemaAST, a node at a time:
//
//   1. The candidates below are decoded through the node, cheapest
//      first; the first one the node accepts is the answer (decoded, so
//      a decoding default or a lenient read supplies its own value).
//   2. A struct (an Objects node with declared properties) is built from
//      its members' stubs: an optional key is left out, any member with
//      no stub blocks the whole struct, and the result must still pass
//      the struct's own checks unless fabrication is on.
//   3. A Suspend node is walked through its thunk.
//   4. Anything else (a union, a literal, an enum, a string or number
//      whose checks refuse the plain empty, an array with a minimum, a
//      declaration) has no structural stub. With fabricateArms a
//      literal pins its value, an enum takes its first member, a union
//      its first arm (walked by the same rules) and a bounded string or
//      number an obviously synthetic placeholder.
import { Exit, Schema, SchemaAST } from "effect";
import type { AnyCodec } from "@shared/ipc/codec";

// Distinct from every legal stub value (undefined included), so the
// caller can tell "no safe stub exists" from "the stub is undefined".
export const NO_STRUCTURAL_STUB = Symbol("no structural stub");

// Candidates tried against a node first, cheapest first. This resolves
// most read-shaped defs outright: void and unknown accept undefined,
// booleans accept false, counts accept 0, ids accept "", nullables
// accept null, lists accept [] and records and all-optional structs
// accept {}.
const CANDIDATES: readonly unknown[] = [undefined, false, 0, "", null, [], {}];

export type StubOptions = {
  // Permit fabricated values (enum, union and literal arms, bounded
  // strings and numbers). Only the bridge allowlist path sets this.
  fabricateArms: boolean;
};

type Stub = unknown | typeof NO_STRUCTURAL_STUB;

export function stubValueFor(schema: AnyCodec, opts: StubOptions): Stub {
  return stubForAst(schema.ast, opts);
}

function decodeCandidate(ast: SchemaAST.AST): Stub {
  const decode = Schema.decodeUnknownExit(Schema.make<AnyCodec>(ast));
  for (const candidate of CANDIDATES) {
    const exit = decode(candidate);
    if (Exit.isSuccess(exit)) return exit.value;
  }
  return NO_STRUCTURAL_STUB;
}

function stubForAst(ast: SchemaAST.AST, opts: StubOptions): Stub {
  const candidate = decodeCandidate(ast);
  if (candidate !== NO_STRUCTURAL_STUB) return candidate;

  switch (ast._tag) {
    case "Suspend":
      return stubForAst(ast.thunk(), opts);
    case "Objects":
      return structStub(ast, opts);
  }

  if (!opts.fabricateArms) return NO_STRUCTURAL_STUB;

  // Fabrication, allowlist-only.
  switch (ast._tag) {
    case "Literal":
      return ast.literal;
    case "Enum":
      return ast.enums[0]?.[1] ?? NO_STRUCTURAL_STUB;
    case "Union": {
      const first = ast.types[0];
      return first === undefined ? NO_STRUCTURAL_STUB : stubForAst(first, opts);
    }
    case "String":
      return "unavailable";
    case "Number":
      return 0;
    default:
      return NO_STRUCTURAL_STUB;
  }
}

// A struct with required members, built from the same rules, so a
// nested enum still blocks the whole stub unless fabrication was
// allowed.
function structStub(ast: SchemaAST.Objects, opts: StubOptions): Stub {
  if (ast.propertySignatures.length === 0) return NO_STRUCTURAL_STUB;
  const out: Record<PropertyKey, unknown> = {};
  for (const property of ast.propertySignatures) {
    if (SchemaAST.isOptional(property.type)) continue;
    const value = stubForAst(property.type, opts);
    if (value === NO_STRUCTURAL_STUB) return NO_STRUCTURAL_STUB;
    if (value !== undefined) out[property.name] = value;
  }
  // A check on the struct as a whole (a cross-field rule) must hold of
  // the built value too. A fabricated member is a placeholder no check
  // was ever meant to pass, so fabrication skips this, as it skips the
  // members' own checks.
  if (!opts.fabricateArms && !Schema.is(Schema.make<AnyCodec>(ast))(out)) {
    return NO_STRUCTURAL_STUB;
  }
  return out;
}
