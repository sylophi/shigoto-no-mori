// A packaged build never runs with Chromium's remote debugging on: a
// debugger on the signed app would act as the app, past the keychain
// access granted to its signature. Nothing the app or its user does
// passes these, so a launch that has them quits before anything opens.
// A dev build turns the port on itself (devCdp.ts), and so does a test
// flavor's, which is never signed (flavor.ts debuggable).
const REMOTE_DEBUGGING = ["remote-debugging-port", "remote-debugging-pipe"];

export function asksForRemoteDebugging(
  hasSwitch: (name: string) => boolean,
): boolean {
  return REMOTE_DEBUGGING.some(hasSwitch);
}
