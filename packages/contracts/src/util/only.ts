// The element of a list that has exactly one, else undefined: for the
// places that read "one match" as an answer and anything else as not.
export function only<T>(list: readonly T[]): T | undefined {
  return list.length === 1 ? list[0] : undefined;
}
