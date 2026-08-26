// The argv flag main uses to hand this build's app version to the
// sandboxed preload (webPreferences.additionalArguments), the same
// channel as the device id and the dev flag. The renderer needs its
// own version synchronously: it rides in the socket hello frame and is
// compared against a remote host's welcome to flag a version skew.
// Must stay a constant-only module: the preload bundle imports it.
export const APP_VERSION_FLAG = "--sm-app-version=";
