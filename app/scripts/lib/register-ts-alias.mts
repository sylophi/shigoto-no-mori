// Registers the tsAliasLoader resolve hook. Passed to node via
// `--import` so the hook is active before the script's own static
// imports of the app's TypeScript are resolved.
import { register } from "node:module";

register("./tsAliasLoader.mts", import.meta.url);
