// The empty answer an invoke's OUTPUT schema allows, for the reads the
// web client cannot serve (localRegistrar.ts says which). Only
// structural emptiness (undefined, false, 0, "", null, [], {} and
// objects built from those): an enum, union or literal arm, or a bounded
// string or number, asserts something (a first arm is affirmative-
// biased: a status enum would stub to its "ok"-like value), so it yields
// NO_STRUCTURAL_STUB and the call is refused. fabricateArms opts back in,
// for the lab's fake host (lab/fake-host/bridge.ts).
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { type ContractSchema, safeDecode } from "@shigomori/contracts/codec";

// Distinct from every legal stub value (undefined included), so the
// caller can tell "no safe stub exists" from "the stub is undefined".
export const NO_STRUCTURAL_STUB = Symbol("no structural stub");

// Candidates tried against the schema first, cheapest first. They
// resolve most read-shaped defs outright: void and unknown accept
// undefined, booleans accept false, counts accept 0, ids accept "",
// nullables accept null, lists accept [] and loose objects and records
// accept {}.
const SCALAR_CANDIDATES: readonly unknown[] = [undefined, false, 0, "", null];

export type StubOptions = {
  // Permit fabricated values (enum, union and literal arms, bounded
  // strings and numbers).
  fabricateArms: boolean;
};

export function stubValueFor(
  schema: ContractSchema,
  opts: StubOptions,
): unknown | typeof NO_STRUCTURAL_STUB {
  // The list and object candidates are fresh per call, so no two
  // stubs share one.
  for (const candidate of [...SCALAR_CANDIDATES, [], {}]) {
    const result = safeDecode(schema, candidate);
    if (result.success) return result.data;
  }
  return stubFromAst(schema.ast, opts);
}

// Objects with required members are built recursively from the same
// rules, so a nested enum still blocks the whole stub unless
// fabrication was allowed. Fabrication, allowlist-only: literals and
// enums pin or pick a value, a union (discriminated included) takes its
// first arm, and bounded scalars get an obviously synthetic placeholder.
function stubFromAst(
  ast: SchemaAST.AST,
  opts: StubOptions,
): unknown | typeof NO_STRUCTURAL_STUB {
  // A strict struct (packages/contracts/src/schemas/strict.ts) is stubbed as the
  // struct it wraps.
  if (
    SchemaAST.isDeclaration(ast) &&
    ast.typeParameters.length === 1 &&
    ast.typeParameters[0] !== undefined &&
    SchemaAST.isObjects(ast.typeParameters[0])
  ) {
    return stubFromAst(ast.typeParameters[0], opts);
  }
  if (SchemaAST.isObjects(ast)) {
    const out: Record<string, unknown> = {};
    for (const field of ast.propertySignatures) {
      if (SchemaAST.isOptional(field.type)) continue;
      const value = stubValueFor(Schema.make(field.type), opts);
      if (value === NO_STRUCTURAL_STUB) return NO_STRUCTURAL_STUB;
      if (value !== undefined) out[String(field.name)] = value;
    }
    return out;
  }
  if (!opts.fabricateArms) return NO_STRUCTURAL_STUB;
  if (SchemaAST.isLiteral(ast)) return ast.literal;
  if (SchemaAST.isUnion(ast)) {
    const first = ast.types[0];
    return first === undefined
      ? NO_STRUCTURAL_STUB
      : stubValueFor(Schema.make(first), opts);
  }
  if (SchemaAST.isString(ast)) return "unavailable";
  if (SchemaAST.isNumber(ast)) return 0;
  return NO_STRUCTURAL_STUB;
}
