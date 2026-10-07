// oxlint's plugin types. oxlint exports only RuleTester, so the rule
// type is read off its `run`, and the rest off the rule.
import type { RuleTester } from "oxlint/plugins-dev";

export type Rule = Extract<
  Parameters<RuleTester["run"]>[1],
  { create: (...args: never[]) => unknown }
>;
type Visitor = ReturnType<Rule["create"]>;
export type Node<K extends keyof Visitor> = Parameters<
  NonNullable<Visitor[K]>
>[0];
