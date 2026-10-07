// Registers the tsAliasLoader resolve hook. Passed to node via
// `--import` so the hook is active before the check module's own static
// imports of the app's TypeScript are resolved.
//
// covers: app/test/lib/tsAliasLoader.mts
import { register } from "node:module";

register("./tsAliasLoader.mts", import.meta.url);
