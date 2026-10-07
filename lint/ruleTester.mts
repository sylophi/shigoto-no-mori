// Runs a rule's cases through oxlint's RuleTester as vitest tests.
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import type { Rule } from "./types.mts";

RuleTester.describe = describe;
RuleTester.it = it;

type Cases = Parameters<RuleTester["run"]>[2];

export function testRule(name: string, rule: Rule, cases: Cases): void {
  new RuleTester().run(name, rule, cases);
}
