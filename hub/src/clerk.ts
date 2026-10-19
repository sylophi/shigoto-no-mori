// What Clerk's verification failures mean to the hub: the token's own
// (refused) or a check that could not run (unavailable).
import {
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";

const CHECK_NOT_RUN: ReadonlySet<string> = new Set([
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.JWKFailedToResolve,
  TokenVerificationErrorReason.InvalidSecretKey,
]);

// Whether a verification failure is the token's (refused), not a check
// that could not run.
export function tokenRefused(error: unknown): boolean {
  return (
    error instanceof TokenVerificationError && !CHECK_NOT_RUN.has(error.reason)
  );
}
