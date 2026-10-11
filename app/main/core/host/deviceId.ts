// The device the shell's account calls name: the id its host reports
// as it comes up (main/hostProcess.ts). A call made while no host is up
// waits for one as long as the host's restart budget allows, then fails
// as a call made before any host had reported always did, so a window
// never hangs on a host that is not coming back.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HostUnreportedError extends Schema.TaggedError<HostUnreportedError>()(
  "HostUnreportedError",
  {},
) {
  override get message(): string {
    return "The device id was asked before launch read it.";
  }
}

export const deviceIdWithin = (
  reported: () => Promise<{ readonly deviceId: string }>,
  budgetMs: number,
) =>
  Effect.promise(reported).pipe(
    Effect.timeoutOrElse({
      duration: budgetMs,
      orElse: () => Effect.fail(new HostUnreportedError()),
    }),
    Effect.map((address) => address.deviceId),
  );
