// The modules every build of the renderer tree resolves once, from the
// app (the desktop renderer, the web client, the fake host, the
// proofs). The workspace packages keep their dependencies in their own
// node_modules, so a module one shares with the app would load twice:
// two Reacts break every hook, two Base UIs every context, and the
// binary codecs of one effect cannot read the schemas another built.
import app from "./package.json" with { type: "json" };
import ui from "../packages/ui/package.json" with { type: "json" };

export const dedupe = [
  "effect",
  ...Object.keys(ui.dependencies).filter((name) => name in app.dependencies),
];
