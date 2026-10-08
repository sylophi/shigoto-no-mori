// A settings document and the keys a scope models, the way the CLI
// reads and edits them: keys are the JSON field names, dotted for
// nesting (scripts.setup).
import * as SchemaAST from "effect/SchemaAST";

export type ConfigDoc = { [key: string]: unknown };

export type ConfigKey = {
  readonly name: string;
  readonly kind: "boolean" | "string" | "enum" | "int" | "list";
  // An enum's members.
  readonly choices: ReadonlyArray<string>;
  // The effective value while the key is absent; undefined when the key
  // is genuinely unset.
  readonly default: unknown;
  // The schema requires it: `set` refuses to clear it, and a whole
  // document must carry it.
  readonly required: boolean;
  // A list key's own verbs, which `set` points at.
  readonly verbs: string | undefined;
  // What is wrong with a list entry, for a whole-document write.
  readonly entryProblem: ((entry: unknown) => string | undefined) | undefined;
};

const isObject = (value: unknown): value is ConfigDoc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const literalsOf = (ast: SchemaAST.AST): ReadonlyArray<string> =>
  SchemaAST.isLiteral(ast)
    ? [String(ast.literal)]
    : SchemaAST.isUnion(ast)
      ? ast.types.flatMap(literalsOf)
      : [];

// The kind of value a field holds, which decides how `set` reads its
// text. A field of any other shape fails at load, so a new kind of
// setting can't slip through as text.
function kindOf(
  name: string,
  members: ReadonlyArray<SchemaAST.AST>,
): ConfigKey["kind"] {
  const [only] = members;
  if (members.every((member) => literalsOf(member).length > 0)) return "enum";
  if (members.length === 1 && only !== undefined) {
    if (SchemaAST.isBoolean(only)) return "boolean";
    if (SchemaAST.isNumber(only)) return "int";
    if (SchemaAST.isArrays(only)) return "list";
    if (SchemaAST.isString(only)) return "string";
  }
  throw new Error(`The setting ${name} has a kind of value sm can't set.`);
}

// The keys a scope models: every field of its schema, in `order` first
// (the order the CLI lists them), then any field `order` doesn't name.
// So a setting the schema gains is listed, readable and clearable with
// nothing else to update.
export function settingKeys(
  fields: ReadonlyArray<{
    readonly path: ReadonlyArray<string>;
    readonly ast: SchemaAST.AST;
  }>,
  defaults: { readonly [name: string]: unknown },
  order: ReadonlyArray<string>,
  lists: {
    readonly [name: string]: {
      readonly verbs?: string;
      readonly entryProblem: (entry: unknown) => string | undefined;
    };
  },
): ReadonlyArray<ConfigKey> {
  const byName = new Map(fields.map(({ path, ast }) => [path.join("."), ast]));
  const names = [
    ...order.filter((name) => byName.has(name)),
    ...[...byName.keys()].filter((name) => !order.includes(name)),
  ];
  return names.map((name) => {
    const ast = byName.get(name) as SchemaAST.AST;
    const members = SchemaAST.isUnion(ast) ? ast.types : [ast];
    const present = members.filter((member) => !SchemaAST.isUndefined(member));
    const kind = kindOf(name, present);
    const choices = kind === "enum" ? literalsOf(ast) : [];
    return {
      name,
      kind,
      choices,
      default: defaults[name],
      required: present.length === members.length,
      verbs: lists[name]?.verbs,
      entryProblem: lists[name]?.entryProblem,
    };
  });
}

// The value at a dotted key, whether it is there, and the parent path
// that holds a non-object where the key expects one. A null parent
// clears everything under it, so its fields read as absent.
export function docGet(
  doc: ConfigDoc,
  name: string,
): readonly [value: unknown, present: boolean, wrongParent?: string] {
  const parts = name.split(".");
  let current: unknown = doc;
  for (const [index, part] of parts.entries()) {
    if (!isObject(current)) {
      return [undefined, false, parts.slice(0, index).join(".")];
    }
    if (!(part in current)) return [undefined, false];
    current = current[part];
    if (current === null && index < parts.length - 1) return [undefined, false];
  }
  return [current, true];
}

export function docSet(doc: ConfigDoc, name: string, value: unknown): void {
  const parts = name.split(".");
  const last = parts.pop() as string;
  let current = doc;
  for (const part of parts) {
    const child = current[part];
    if (!isObject(child)) current[part] = {};
    current = current[part] as ConfigDoc;
  }
  current[last] = value;
}

// Removes a dotted key, and the parents it leaves empty, so clearing
// scripts.teardown doesn't leave `"scripts": {}` behind.
export function docDelete(doc: ConfigDoc, name: string): void {
  const parts = name.split(".");
  const parents: ConfigDoc[] = [doc];
  let current = doc;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!isObject(child)) return;
    parents.push(child);
    current = child;
  }
  delete current[parts[parts.length - 1] as string];
  for (let index = parents.length - 1; index > 0; index--) {
    if (Object.keys(parents[index] as ConfigDoc).length !== 0) break;
    delete (parents[index - 1] as ConfigDoc)[parts[index - 1] as string];
  }
}

// docDelete for a whole-document write, which must not give up: a
// parent holding a non-object is dropped whole, since a scalar, an array
// or a null has no fields under it to keep.
function docClear(doc: ConfigDoc, name: string): void {
  const parts = name.split(".");
  let current = doc;
  for (const [index, part] of parts.slice(0, -1).entries()) {
    if (!(part in current)) return;
    const child = current[part];
    if (!isObject(child)) {
      docDelete(doc, parts.slice(0, index + 1).join("."));
      return;
    }
    current = child;
  }
  docDelete(doc, name);
}

// A null deletes its key, an object merges into the stored object field
// by field, anything else replaces what is there. An object the
// payload's nulls empty is dropped; an empty object sent is kept.
function mergeObjects(doc: ConfigDoc, payload: ConfigDoc): void {
  for (const [name, value] of Object.entries(payload)) {
    if (value === null) {
      delete doc[name];
    } else if (isObject(value)) {
      const existing = isObject(doc[name]) ? (doc[name] as ConfigDoc) : {};
      mergeObjects(existing, value);
      if (
        Object.keys(existing).length === 0 &&
        Object.keys(value).length !== 0
      ) {
        delete doc[name];
      } else {
        doc[name] = existing;
      }
    } else {
      doc[name] = value;
    }
  }
}

// What a whole-document write lands: a modeled key the payload omits is
// removed, then the payload merges in. Keys only a newer build models
// survive an older build's save.
export function mergeConfigDoc(
  keys: ReadonlyArray<ConfigKey>,
  doc: ConfigDoc,
  payload: ConfigDoc,
): void {
  for (const key of keys) {
    if (!docGet(payload, key.name)[1]) docClear(doc, key.name);
  }
  mergeObjects(doc, payload);
}

const filled = (value: unknown) =>
  typeof value === "string" && value.trim() !== "";

// What is wrong with a launcher, a hidden launcher id and a carry-over
// entry, in the words a refused write uses.
export const launcherProblem = (entry: unknown) => {
  if (!isObject(entry)) return "entries must be objects";
  const missing = ["id", "label", "command"].find(
    (field) => !filled(entry[field]),
  );
  return missing === undefined
    ? undefined
    : `entries need a non-empty ${missing}`;
};

export const launcherIdProblem = (entry: unknown) =>
  typeof entry === "string" ? undefined : "entries must be strings";

// Relative, with no `..` step and no NUL.
const isSafeRelativePath = (path: string) =>
  !path.startsWith("/") &&
  !path.includes("\u0000") &&
  !path.split(/[\\/]/).includes("..");

export const carryOverProblem = (entry: unknown) => {
  if (!isObject(entry)) return "entries must be objects";
  const { path, mode } = entry;
  if (typeof path !== "string" || path === "" || !isSafeRelativePath(path)) {
    return "entries need a path inside the project root";
  }
  return mode === "copy" || mode === "symlink"
    ? undefined
    : "entries need mode copy or symlink";
};

// What keeps a whole document from being written: a required key
// missing, or a modeled key holding the wrong kind of value. A null
// clears its key, so it passes wherever the key may be absent.
export function documentProblem(
  keys: ReadonlyArray<ConfigKey>,
  doc: ConfigDoc,
): string | undefined {
  for (const key of keys) {
    const [value, present, wrongParent] = docGet(doc, key.name);
    if (wrongParent !== undefined) return `${wrongParent} must be an object.`;
    if (!present || value === null) {
      if (key.required) return `${key.name} is required.`;
      continue;
    }
    const problem = valueProblem(key, value);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function valueProblem(key: ConfigKey, value: unknown): string | undefined {
  switch (key.kind) {
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : `${key.name} must be a boolean.`;
    case "string":
      if (typeof value !== "string") return `${key.name} must be a string.`;
      return key.required && value.trim() === ""
        ? `${key.name} is required.`
        : undefined;
    case "enum":
      if (typeof value !== "string") return `${key.name} must be a string.`;
      return key.choices.includes(value)
        ? undefined
        : `${key.name} must be one of: ${key.choices.join(", ")}.`;
    case "int":
      return Number.isSafeInteger(value) && (value as number) > 0
        ? undefined
        : `${key.name} must be a positive integer.`;
    case "list": {
      if (!Array.isArray(value)) return `${key.name} must be an array.`;
      for (const entry of value) {
        const problem = key.entryProblem?.(entry);
        if (problem !== undefined) return `${key.name}: ${problem}.`;
      }
      return undefined;
    }
  }
}
