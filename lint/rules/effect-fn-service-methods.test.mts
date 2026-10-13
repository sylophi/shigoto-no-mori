import { testRule } from "../ruleTester.mts";
import rule from "./effect-fn-service-methods.mts";

const service = "engine/src/Registry.ts";

// A tag whose interface has two effect methods, a stream and a value.
const tag = `
class Registry extends Context.Service<
  Registry,
  {
    readonly read: (id: string) => Effect.Effect<string>;
    write(id: string): Effect.Effect<void>;
    readonly changes: (id: string) => Stream.Stream<string>;
    readonly now: () => number;
    readonly current: Effect.Effect<string>;
  }
>()("sm/engine/Registry") {}
`;

testRule("effect-fn-service-methods", rule, {
  valid: [
    {
      code: `${tag}
Registry.of({
  read: Effect.fn("Registry.read")(function* (id: string) { return id; }),
  write: Effect.fn("Registry.write")((id: string) => Effect.log(id)),
  changes: (id) => Stream.make(id),
  now: () => 1,
  current: Effect.succeed(""),
});`,
      filename: service,
    },
    {
      code: `${tag}
const read = Effect.fn("Registry.read")(function* (id: string) { return id; });
const write = sub.write;
Registry.of({ read, write, changes, now, current });`,
      filename: service,
    },
    // A name bound twice, in two scopes, is left alone.
    {
      code: `${tag}
const inner = () => { const read = (id: string) => Effect.succeed(id); };
const read = Effect.fn("Registry.read")(function* (id: string) { return id; });
Registry.of({ read });`,
      filename: service,
    },
    // Not a service module, or a tag this module doesn't declare.
    {
      code: `${tag}
Registry.of({ read: (id) => Effect.succeed(id) });`,
      filename: "engine/src/registry.ts",
    },
    {
      code: "Other.of({ read: (id) => Effect.succeed(id) });",
      filename: service,
    },
  ],
  invalid: [
    {
      code: `${tag}
Registry.of({ read: (id) => Effect.succeed(id) });`,
      filename: service,
      errors: 1,
    },
    {
      code: `${tag}
Registry.of({ write(id) { return Effect.log(id); } });`,
      filename: service,
      errors: 1,
    },
    {
      code: `${tag}
const read = (id: string) => Effect.succeed(id);
function write(id: string) { return Effect.log(id); }
Registry.of({ read, write });`,
      filename: service,
      errors: 2,
    },
  ],
});
