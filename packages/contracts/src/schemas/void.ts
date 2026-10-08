import * as Schema from "effect/Schema";

// A call that takes or returns nothing. Refuses anything but undefined,
// where Schema.Void would accept any value and decode it to undefined.
export const VoidSchema = Schema.declare(
  (value: unknown): value is void => value === undefined,
);
