import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

// A call that takes or returns nothing. Refuses anything but undefined,
// where Schema.Void would accept any value and decode it to undefined.
// In JSON (the device link's codec) it is null, as Schema.Void is.
export const VoidSchema = Schema.declare(
  (value: unknown): value is void => value === undefined,
  {
    toCodecJson: () =>
      Schema.link<void>()(
        Schema.Null,
        SchemaTransformation.transform<void, null>({
          decode: () => undefined,
          encode: () => null,
        }),
      ),
  },
);
