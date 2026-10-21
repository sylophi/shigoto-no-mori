// The React Compiler pass, one definition for every build that mounts
// the renderer tree (the desktop renderer, the web client, the fake host).
// @vitejs/plugin-react has no babel option (it runs Oxc), so the
// compiler runs through @rolldown/plugin-babel with the react plugin's
// own preset.
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// What the compiler is handed, by the builds and by the bailout check
// (scripts/react-compiler-check.mts), which adds its logger.
export const REACT_COMPILER_OPTIONS = {};

export function reactCompiler() {
  return babel({ presets: [reactCompilerPreset(REACT_COMPILER_OPTIONS)] });
}
