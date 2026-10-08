// JSON text, none when it isn't.
import * as Option from "effect/Option";

export const parseJson = (raw: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(raw) as unknown);
  } catch {
    return Option.none();
  }
};
