// Barrel: each domain owns its schemas in a sibling file; this index
// re-exports them so consumers can keep importing from "@shared/schemas"
// without caring about the split.
//
// main/lib/** should `import type` from this barrel. Schemas are part of
// the IPC contract: runtime parsing happens at the IPC boundary (input
// in main/ipc/register.ts, payload in `broadcast`), not inside backend
// logic. Renderer code and main/ipc/** are free to runtime-import.
export * from "./payloads";
export * from "./project";
export * from "./worktree";
export * from "./pullRequest";
export * from "./config";
export * from "./launchers";
export * from "./scripts";
export * from "./fs";
export * from "./shell";
export * from "./runtime";
