// package.json's scripts in manifest order, as the Go sm read them:
// only string-valued entries count, a duplicated name is listed twice,
// and a missing or non-object scripts block means none. JSON.parse
// would put integer-like names first and keep one of each duplicate,
// so after it vouches for the text, the members are walked in order.

export type PackageScript = { readonly name: string; readonly command: string };

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

// The members of the object starting at `start`, in order, each value
// as its source text.
function members(text: string, start: number) {
  const found: Array<{ name: string; value: string }> = [];
  let at = start + 1;
  const skipSpace = () => {
    while (WHITESPACE.has(text[at] as string)) at++;
  };
  // The end of the string literal starting at `at`.
  const stringEnd = (from: number) => {
    let end = from + 1;
    while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    return end + 1;
  };
  // The end of the value starting at `at`.
  const valueEnd = (from: number) => {
    if (text[from] === '"') return stringEnd(from);
    if (text[from] !== "{" && text[from] !== "[") {
      let end = from;
      while (end < text.length && !/[\s,}\]]/.test(text[end] as string)) end++;
      return end;
    }
    let depth = 0;
    let end = from;
    do {
      const char = text[end];
      if (char === '"') {
        end = stringEnd(end);
        continue;
      }
      if (char === "{" || char === "[") depth++;
      if (char === "}" || char === "]") depth--;
      end++;
    } while (depth > 0);
    return end;
  };
  skipSpace();
  while (text[at] === '"') {
    const nameEnd = stringEnd(at);
    const name = JSON.parse(text.slice(at, nameEnd)) as string;
    at = nameEnd;
    skipSpace();
    at++; // the colon
    skipSpace();
    const end = valueEnd(at);
    found.push({ name, value: text.slice(at, end) });
    at = end;
    skipSpace();
    if (text[at] === ",") {
      at++;
      skipSpace();
    }
  }
  return found;
}

const objectStart = (text: string, from = 0) => {
  let at = from;
  while (WHITESPACE.has(text[at] as string)) at++;
  return text[at] === "{" ? at : undefined;
};

// Throws on text that isn't JSON or isn't an object (null reads as no
// scripts).
export function packageScripts(text: string): ReadonlyArray<PackageScript> {
  const top: unknown = JSON.parse(text);
  if (top === null) return [];
  if (typeof top !== "object" || Array.isArray(top)) {
    throw new Error("package.json is not a JSON object");
  }
  const scripts = members(text, objectStart(text) as number).findLast(
    ({ name }) => name === "scripts",
  );
  const start = scripts && objectStart(scripts.value);
  if (scripts === undefined || start === undefined) return [];
  return members(scripts.value, start).flatMap(({ name, value }) => {
    const command: unknown = JSON.parse(value);
    return typeof command === "string" ? [{ name, command }] : [];
  });
}
