/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// electron-squirrel-startup ships no types: it exports a boolean that is
// true when this launch is a Squirrel.Windows install/update/uninstall
// event the process should exit after handling.
declare module "electron-squirrel-startup" {
  const handledSquirrelEvent: boolean;
  export default handledSquirrelEvent;
}
