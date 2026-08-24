// The argv flag main uses to hand the device id to the sandboxed
// preload (webPreferences.additionalArguments). One constant imported
// by both sides so they can't disagree on the spelling. Must stay a
// constant-only module: the preload bundle imports it.
export const DEVICE_ID_FLAG = "--sm-device-id=";
