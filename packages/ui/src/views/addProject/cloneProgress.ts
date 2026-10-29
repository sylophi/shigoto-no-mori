import type {
  CloneFromDeviceProgress,
  CloneProgress,
} from "@shigomori/contracts/modules/projects";
import { formatBytes } from "../../lib/formatBytes.ts";
import { byteRatio } from "../worktreeDetail/flow/pullSteps.ts";

// Each step's share of the bar: the download is most of a clone. The
// remote counts and then compresses, each from 0 to 100, so its percent
// moves neither the bar nor the caption.
const SPANS: Record<CloneProgress["step"], readonly [number, number]> = {
  remote: [0, 0],
  receiving: [0, 0.85],
  resolving: [0.85, 0.95],
  checkout: [0.95, 1],
};

const WORDS: Record<CloneProgress["step"], string> = {
  remote: "Packing on the remote",
  receiving: "Downloading",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};

// A clone's progress as ProgressPanelView draws it.
export function cloneProgressBar({ step, percent, bytes }: CloneProgress) {
  const [from, to] = SPANS[step];
  return {
    ratio: from + ((to - from) * percent) / 100,
    caption:
      step === "remote"
        ? WORDS[step]
        : `${WORDS[step]}: ${percent}%${bytes === undefined ? "" : ` (${formatBytes(bytes)})`}`,
  };
}

// A clone of another device's project, the same way: the repo is most of
// it, and the carry-over files (when it has any) the rest.
export function cloneFromDeviceProgressBar(progress: CloneFromDeviceProgress) {
  const { step, bytes, totalBytes } = progress;
  const files = step === "files";
  const share = byteRatio(progress);
  const words = files ? "Copying carry-over files" : "Copying the repo";
  return {
    ratio: files ? 0.9 + 0.1 * share : 0.9 * share,
    caption:
      bytes === undefined || !totalBytes
        ? words
        : `${words}: ${Math.round(share * 100)}% (${formatBytes(bytes)} of ${formatBytes(totalBytes)})`,
  };
}
