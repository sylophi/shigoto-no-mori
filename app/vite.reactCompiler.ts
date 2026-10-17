// The React Compiler pass, one definition for every build that mounts
// the renderer tree (the desktop renderer, the web client, the fake host).
// @vitejs/plugin-react v6 dropped its inline babel option (it switched
// to Oxc for Fast Refresh), so the compiler ships via
// @rolldown/plugin-babel using the canonical preset exported by the
// react plugin itself.
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// What the compiler is handed, by the builds and by the bailout check
// (scripts/react-compiler-check.mts), which adds its logger.
export const REACT_COMPILER_OPTIONS = {};

export function reactCompiler() {
  return babel({ presets: [reactCompilerPreset(REACT_COMPILER_OPTIONS)] });
}
