// The lab's entry, for the cross-device walks (app/lab/walks): the
// worker as deployed, but a login is "lab:<account>" in place of a Clerk
// session token, so lab builds on one machine enroll as devices of one
// account with no Clerk and no network. Never deployed: the deploy
// scripts take wrangler.jsonc, and the walks write a config of their own
// for this (app/lab/walks/lib/labHub.mts).
import { createWorker } from "./worker.ts";

export { DeviceHub } from "./hubObject.ts";

const LAB_LOGIN = /^lab:([a-z0-9-]{1,64})$/;

export default createWorker({
  verifyLogin: async (token) => {
    const account = LAB_LOGIN.exec(token)?.[1];
    return account === undefined ? null : { accountId: `lab_${account}` };
  },
});
