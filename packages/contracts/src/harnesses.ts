// The agent harnesses with built-in support: the engine installs their
// hooks and `sm agents resume` resumes their sessions
// (engine/src/agentHooks.ts), the guide opens one, and the views name a
// session by its harness.
export const KNOWN_HARNESS_IDS = ["claude", "codex"] as const;
export type KnownHarness = (typeof KNOWN_HARNESS_IDS)[number];

const KNOWN: Record<KnownHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

// One harness's id and name, for the engine's fuller description.
export const knownHarness = (id: KnownHarness) => ({ id, label: KNOWN[id] });

// Built in, so a session of it can be resumed.
export const isKnownHarness = (harness: string): harness is KnownHarness =>
  Object.hasOwn(KNOWN, harness);

// A harness without built-in support goes by the name it gave itself.
export const harnessLabel = (harness: string): string =>
  isKnownHarness(harness) ? KNOWN[harness] : harness;
