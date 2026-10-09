// Barrel: each domain owns its schemas in a sibling file; this index
// re-exports them so consumers import @shigomori/contracts/schemas
// without caring about the split.
//
// host/lib/** should `import type` from this barrel. Schemas are part of
// the IPC contract: runtime parsing happens at the IPC boundary (input
// in main/ipc/register.ts, payload in `broadcast`), not inside backend
// logic. Renderer code, main/ipc/**, and host/ipc/** are free to
// runtime-import.
export * from "./payloads.ts";
export * from "./project.ts";
export * from "./worktree.ts";
export * from "./changes.ts";
export * from "./files.ts";
export * from "./hygiene.ts";
export * from "./pullRequest.ts";
export * from "./config.ts";
export * from "./launchers.ts";
export * from "./scripts.ts";
export * from "./terrier.ts";
export * from "./fs.ts";
export * from "./shell.ts";
export * from "./runtime.ts";
export * from "./ports.ts";
export * from "./sharedSettings.ts";
export * from "./villagers.ts";
export * from "./releases.ts";
export * from "./agents.ts";
export * from "./void.ts";
