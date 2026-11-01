import * as Option from "effect/Option";

// JSON text, none when it isn't.
export const parseJson = (raw: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(raw) as unknown);
  } catch {
    return Option.none();
  }
};

// A value as JSON with every object's keys sorted, the one form two
// spellings of the same input share.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// --- JSON text read in order, keeping each value's text ---

// Where the JSON value (or key) starting at `start` ends, in text
// JSON.parse has already accepted.
export function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    let i = start + 1;
    for (; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === "\\") i++;
    }
    return i + 1;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        i = valueEnd(text, i) - 1;
      } else if (c === "{" || c === "[") {
        depth++;
      } else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !/[\s,:}\]]/.test(text[i] ?? "")) i++;
  return i;
}

export const skipSpace = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
};

// The items of a JSON object or array in order, each as its text: a key
// and its value's text for an object, the item's text for an array. A
// key given twice is listed twice.
export function members(text: string): Array<[key: string, raw: string]> {
  const object = text.startsWith("{");
  const close = object ? "}" : "]";
  const found: Array<[string, string]> = [];
  let i = skipSpace(text, 1);
  while (i < text.length && text[i] !== close) {
    let key = "";
    if (object) {
      const keyEnd = valueEnd(text, i);
      key = JSON.parse(text.slice(i, keyEnd)) as string;
      i = skipSpace(text, skipSpace(text, keyEnd) + 1);
    }
    const end = valueEnd(text, i);
    found.push([key, text.slice(i, end)]);
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return found;
}
