// oxlint-disable no-underscore-dangle -- standard Vite `define` naming convention.
// What scripts/build-headless.mts bakes into the headless bundle: whether
// it was built to ship (a dev run's isn't), and the app's version from
// package.json. Read only by headless/facts.ts.
declare const __SM_HEADLESS_PACKAGED__: boolean;
declare const __SM_APP_VERSION__: string;
