// How the app puts its command on PATH and takes it off, one OS's
// mechanism behind the Settings actions and the launch-time repair
// (install.ts).
import type { CliStatus } from "@shigomori/contracts/modules/cli";
import type * as HostFacts from "@host/lib/HostFacts";

export type Facts = HostFacts.HostFacts["Service"];

export type CliPlacement = {
  readonly status: (facts: Facts) => Promise<CliStatus>;
  readonly install: (facts: Facts, force: boolean) => Promise<CliStatus>;
  readonly remove: (facts: Facts) => Promise<void>;
  readonly repair: (facts: Facts) => Promise<void>;
};
