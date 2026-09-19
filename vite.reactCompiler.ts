// The React Compiler pass, one definition for every build that mounts
// the renderer tree (the desktop renderer, the web client, the UI lab).
// @vitejs/plugin-react v6 dropped its inline babel option (it switched
// to Oxc for Fast Refresh), so the compiler ships via
// @rolldown/plugin-babel using the canonical preset exported by the
// react plugin itself.
//
// The plugin parses .ts and .tsx as TypeScript and nothing else, so a
// .mts module (shared/git/repoIdentity.mts, which node scripts also
// load directly) reaches babel as plain JavaScript and fails on its
// first type. The override teaches it the third extension.
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export function reactCompiler() {
  return babel({
    presets: [reactCompilerPreset()],
    overrides: [
      // `include` is babel's synonym for `test`, and the one of the two
      // the plugin's types admit.
      { include: /\.mts(?:$|\?)/, parserOpts: { plugins: ["typescript"] } },
    ],
  });
}
