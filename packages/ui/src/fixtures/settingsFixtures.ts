// What a device's Settings show about its machine: the launch tools it
// detects, the agent hooks it holds, its CLI install and a health
// check's report. The fake host serves the first two. The rest it has
// no channel for, and a picture of the page uses them (../scenes).
import type {
  CliStatus,
  DoctorReport,
  ShellIntegrationStatus,
} from "@shigomori/contracts/modules/cli";
import type { AgentHarnessStatus } from "@shigomori/contracts/schemas/index";

export const FAKE_DETECTED = [
  { kind: "detected", id: "app:vscode", label: "VS Code", available: true },
  { kind: "detected", id: "app:terminal", label: "Terminal", available: true },
  { kind: "detected", id: "app:ghostty", label: "Ghostty", available: true },
  { kind: "detected", id: "app:finder", label: "Finder", available: true },
  { kind: "detected", id: "app:codex", label: "ChatGPT", available: true },
  {
    kind: "detected",
    id: "app:claude-code",
    label: "Claude Code",
    available: true,
  },
  { kind: "detected", id: "app:neovim", label: "Neovim", available: true },
  { kind: "detected", id: "app:lazygit", label: "lazygit", available: true },
  { kind: "detected", id: "app:gemini", label: "Gemini CLI", available: false },
  {
    kind: "detected",
    id: "app:copilot",
    label: "Copilot CLI",
    available: false,
  },
  { kind: "detected", id: "app:vim", label: "Vim", available: false },
  { kind: "detected", id: "app:helix", label: "Helix", available: false },
] as const;

// Claude Code's hooks in, Codex's waiting on a fresh install.
export function fakeAgentHarnesses(home: string): AgentHarnessStatus[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      detected: true,
      path: `${home}/.claude/settings.json`,
      hooks: "installed",
    },
    {
      id: "codex",
      label: "Codex",
      detected: true,
      path: `${home}/.codex/hooks.json`,
      hooks: "missing",
    },
  ];
}

// The CLI linked into ~/.local/bin, on PATH.
export function fakeCliStatus(home: string): CliStatus {
  return {
    name: "sm",
    aliasName: "shigomori",
    binDir: `${home}/.local/bin`,
    linkPath: `${home}/.local/bin/sm`,
    state: "installed",
    foreignPaths: [],
    onPath: true,
  };
}

export function fakeShellStatus(home: string): ShellIntegrationStatus {
  return {
    loginShell: "zsh",
    shells: [
      { shell: "zsh", path: `${home}/.zshrc`, state: "installed" },
      { shell: "bash", path: `${home}/.bashrc`, state: "missing" },
    ],
  };
}

// A health check that found a stale lock to repair and a project gone
// from disk, beside the checks that passed.
export const FAKE_DOCTOR_REPORT: DoctorReport = {
  summary: { ok: 6, warn: 1, fail: 1 },
  repaired: [],
  repairFailed: [],
  checks: [
    {
      group: "Install",
      id: "cli",
      title: "CLI",
      status: "ok",
      detail: "`sm` 2.0.3 on PATH",
    },
    {
      group: "Install",
      id: "shell",
      title: "Shell integration",
      status: "ok",
      detail: "enabled for zsh",
    },
    {
      group: "Data dir",
      id: "writable",
      title: "Writable",
      status: "ok",
      detail: "~/.sm",
    },
    {
      group: "Data dir",
      id: "locks",
      title: "Locks",
      status: "warn",
      detail: "a lock left by a process that is gone",
      fix: "Remove it with `sm doctor --fix`.",
      repairable: true,
    },
    {
      group: "Processes",
      id: "daemon",
      title: "Engine",
      status: "ok",
      detail: "running",
    },
    {
      group: "Projects",
      id: "missing",
      title: "old-blog",
      status: "fail",
      detail: "folder not found at ~/Code/old-blog",
      fix: "Remove the project with `sm project rm old-blog`, or put the folder back.",
    },
    {
      group: "Projects",
      id: "ok",
      title: "shigoto-no-mori",
      status: "ok",
      detail: "5 worktrees",
    },
    {
      group: "Projects",
      id: "ok",
      title: "port-pool",
      status: "ok",
      detail: "2 worktrees",
    },
  ],
};
