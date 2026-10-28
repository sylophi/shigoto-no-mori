import * as Schema from "effect/Schema";
import { defineContract, invoke, Remote } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// The terminal's sign-in on a machine with no windows (`sm login`,
// `sm logout`), which only the headless host serves: an app with
// windows signs in at them. It is Clerk's device grant: the host asks
// Clerk for a code, the person approves it on Clerk's page from another
// device, and the host, asking Clerk until they have, enrolls this
// device with the hub under the token it gets. Loopback only, and kept
// out of allContractModules, so no window's api carries it.

export const LoginCodeSchema = strict(
  Schema.Struct({
    // What the person enters at verificationUri. The complete URI has
    // it in already.
    userCode: Schema.String,
    verificationUri: Schema.String,
    verificationUriComplete: Schema.optional(Schema.String),
    // What the host asks Clerk with, handed back to finish.
    deviceCode: Schema.String,
    // Seconds: how often Clerk may be asked, and how long the code
    // lives.
    interval: Schema.Int,
    expiresIn: Schema.Int,
  }),
);
export type LoginCode = typeof LoginCodeSchema.Type;

const LoginStatusSchema = strict(
  Schema.Struct({
    signedIn: Schema.Boolean,
    // The name this device goes by on the account, or would enroll
    // under.
    deviceName: Schema.String,
  }),
);
export type LoginStatus = typeof LoginStatusSchema.Type;

export const loginContract = defineContract(
  "login",
  "host",
  invoke("status", VoidSchema, LoginStatusSchema),
  // Refused while signed in.
  invoke("start", VoidSchema, LoginCodeSchema),
  // Answers once the person approved and this device enrolled. Refused
  // when they denied it or the code expired.
  invoke("finish", LoginCodeSchema, LoginStatusSchema),
  invoke("signOut", VoidSchema, VoidSchema),
).annotateRpcs(Remote, false);
