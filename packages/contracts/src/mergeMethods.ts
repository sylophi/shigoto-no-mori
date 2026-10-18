// How a pull request merges: the methods a repo's merge button offers,
// the one a merge takes, and the verdicts that arm auto-merge instead.
// The engine's landing merges by them and the merge box draws them.
import {
  MergeMethodSchema,
  type MergeMethod,
  type RepoMergeConfig,
} from "./schemas/pullRequest.ts";

// The repo's merge settings: the methods its merge button offers, in
// MergeMethodSchema's order, and whether auto-merge may be armed on its
// PRs.
export interface MergeSettings {
  readonly allowed: ReadonlyArray<MergeMethod>;
  readonly autoMerge: boolean;
}

// A config that could not be read allows every method, so a merge isn't
// blocked by missing data, and no auto-merge, which GitHub refuses to
// arm where the repo doesn't allow it.
export function mergeSettingsOf(config: RepoMergeConfig | null): MergeSettings {
  if (config === null) {
    return { allowed: MergeMethodSchema.literals, autoMerge: false };
  }
  return {
    allowed: MergeMethodSchema.literals.filter((method) => config[method]),
    autoMerge: config.autoMerge,
  };
}

// The method a merge takes with none asked for: the last one picked
// while the repo still allows it, else the first allowed. Null with
// none allowed.
export function pickMergeMethod(
  allowed: ReadonlyArray<MergeMethod>,
  last: unknown,
): MergeMethod | null {
  return allowed.find((method) => method === last) ?? allowed[0] ?? null;
}

// The verdicts auto-merge is for: the base branch's rules aren't met yet,
// or the head must catch up with a base that requires it. Anything else
// merges now, or keeps the plain merge's refusal.
export const autoMergeArms = (status: string | undefined) =>
  status === "BLOCKED" || status === "BEHIND";
