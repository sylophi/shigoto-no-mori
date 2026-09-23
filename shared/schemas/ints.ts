import { Schema } from "effect";

// The two integer shapes the contracts count with (line counts, ports,
// ids, byte totals). Natural is Effect's own Int >= 0.
export const NonNegativeInt = Schema.Natural;
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
