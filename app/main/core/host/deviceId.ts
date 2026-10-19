// The device the shell's account calls name: the id its host reports
// as it comes up (main/hostProcess.ts), which names the data dir and so
// outlives a restart. Before any host has reported, a call waits for
// one as long as the host's restart budget allows, then fails, so a
// window never hangs on a host that is not coming back.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HostUnreportedError extends Schema.TaggedError<HostUnreportedError>()(
  "HostUnreportedError",
  {},
) {
  override get message(): string {
    return "No host came up to say which device this is.";
  }
}

export const deviceIdWithin = (
  known: string | undefined,
  reported: () => Promise<{ readonly deviceId: string }>,
  budgetMs: number,
): Effect.Effect<string, HostUnreportedError> =>
  known !== undefined
    ? Effect.succeed(known)
    : Effect.promise(reported).pipe(
        Effect.timeoutOrElse({
          duration: budgetMs,
          orElse: () => Effect.fail(new HostUnreportedError()),
        }),
        Effect.map((address) => address.deviceId),
      );
