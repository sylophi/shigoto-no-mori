// Registers the tsAliasLoader resolve hook. Passed to node via
// `--import` so the hook is active before the check module's own static
// imports of the app's TypeScript are resolved.
import { register } from "node:module";

register("./tsAliasLoader.mjs", import.meta.url);
