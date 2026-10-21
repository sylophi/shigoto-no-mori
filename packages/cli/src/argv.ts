// The command line's parsing, in front of effect/cli's: flags and
// positionals interleave, any number of leading dashes name a flag
// (`-no-cd`), a valued flag takes the next argument whatever it is, the
// last of a repeated flag wins (a list flag keeps each), a boolean
// takes no value, and `--` makes the rest positional. The command line
// comes out in the one form effect/cli reads the same way: the
// command's names, each flag as `--name=value` (a boolean as `=true`,
// so no positional after it reads as its value), then the positionals.
// Each command's flags are read from its own definition.
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Command from "effect/cli/Command";
import * as Param from "effect/cli/Param";
import { unknownCommand, UsageError } from "./errors.ts";
import { Output } from "./output.ts";

type Flag = {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly valued: boolean;
  readonly list: boolean;
};

const flagOf = (param: Param.Any, list = false): Flag => {
  if (Param.isSingle(param)) {
    return {
      name: param.name,
      aliases: param.aliases,
      valued: !Predicate.isTagged(param.primitiveType, "Boolean"),
      list,
    };
  }
  if (!("param" in param) || !Param.isParam(param.param)) {
    throw new Error("effect/cli has a flag that wraps none");
  }
  return flagOf(param.param, list || Predicate.isTagged(param, "Variadic"));
};

// The flags a command declares: its own (`config`), and the shared ones
// its subcommands inherit (`contextConfig`). effect/cli keeps them on the
// command without a public accessor; effect is pinned, and every run
// reads them, so a change there fails every test.
const declared = (
  command: Command.Command.Any,
  field: "config" | "contextConfig",
): ReadonlyArray<Param.Any> => {
  const config: unknown = Reflect.get(command, field);
  if (
    Predicate.hasProperty(config, "flags") &&
    Array.isArray(config.flags) &&
    config.flags.every(Param.isParam)
  ) {
    return config.flags;
  }
  throw new Error(`effect/cli no longer exposes ${command.name}'s flags`);
};

type Flags = ReadonlyMap<string, Flag>;

const index = (params: ReadonlyArray<Param.Any>, into: Map<string, Flag>) => {
  for (const flag of params.map((param) => flagOf(param))) {
    for (const name of [flag.name, ...flag.aliases]) into.set(name, flag);
  }
  return into;
};

// Every flag the command at the end of `chain` reads, by name and alias:
// its own and the ones its ancestors share.
const flagsOf = (chain: ReadonlyArray<Command.Command.Any>): Flags =>
  chain.reduce(
    (into, command, i) =>
      index(
        [
          ...(i === chain.length - 1 ? declared(command, "config") : []),
          ...declared(command, "contextConfig"),
        ],
        into,
      ),
    new Map<string, Flag>(),
  );

// Every flag a namespace and the commands under it read: the one spec
// they are all parsed with.
const namespaceFlags = (chain: ReadonlyArray<Command.Command.Any>): Flags => {
  const into = new Map(flagsOf(chain));
  const under = (command: Command.Command.Any): void => {
    for (const { commands } of command.subcommands) {
      for (const each of commands) {
        index(
          [...declared(each, "config"), ...declared(each, "contextConfig")],
          into,
        );
        under(each);
      }
    }
  };
  under(chain[chain.length - 1] as Command.Command.Any);
  return into;
};

// The namespaces that parse the flags first and take the verb from the
// first positional. Every other takes it from the first argument, a
// flag included.
const FLAGS_FIRST = new Set(["config", "projects config"]);

const subcommand = (command: Command.Command.Any, word: string) =>
  command.subcommands
    .flatMap(({ commands }) => commands)
    .find(({ name, alias }) => name === word || alias === word);

const isFlag = (arg: string) => arg.startsWith("-") && arg !== "-";

// A flag argument's name and its inline value, if any.
const split = (arg: string) => {
  const name = arg.replace(/^-+/, "");
  const eq = name.indexOf("=");
  return eq === -1
    ? { name, inline: undefined }
    : { name: name.slice(0, eq), inline: name.slice(eq + 1) };
};

// A command line's words before its `--`, and the ones past it, which
// are the command's whatever they look like (undefined without one).
export const splitAtDashes = (args: ReadonlyArray<string>) => {
  const end = args.indexOf("--");
  return end === -1
    ? { own: args, past: undefined }
    : { own: args.slice(0, end), past: args.slice(end + 1) };
};

const refuse = (problem: string) => Effect.fail(new UsageError({ problem }));

// The flags `tokens` give, by name, and the positionals between them.
const parse = (tokens: ReadonlyArray<string>, flags: Flags) =>
  Effect.suspend(() => {
    const values = new Map<string, string[] | true>();
    const positionals: string[] = [];
    // Where the first positional is, -1 without one.
    let first = -1;
    for (let i = 0; i < tokens.length; i++) {
      const arg = tokens[i] as string;
      if (!isFlag(arg)) {
        if (first === -1) first = i;
        positionals.push(arg);
        continue;
      }
      const { name, inline } = split(arg);
      const flag = flags.get(name);
      if (flag === undefined) {
        return refuse(`Unknown option ${JSON.stringify(arg)}.`);
      }
      if (!flag.valued) {
        if (inline !== undefined) {
          return refuse(`Option ${JSON.stringify(arg)} takes no value.`);
        }
        values.set(flag.name, true);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        i++;
        if (i >= tokens.length) {
          return refuse(`Option ${JSON.stringify(arg)} requires a value.`);
        }
        value = tokens[i] as string;
      }
      const held = values.get(flag.name);
      values.set(
        flag.name,
        flag.list && Array.isArray(held) ? [...held, value] : [value],
      );
    }
    return Effect.succeed({ values, positionals, first });
  });

// The command line under `root` (its words after the binary's) as
// effect/cli is to read it, or its refusal.
export const commandLine = (
  root: Command.Command.Any,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const { binaryName } = yield* Effect.service(Output);
    const line = splitAtDashes(args);
    const tokens = [...line.own];

    // The command, a level at a time. A flags-first namespace's flags
    // stay valid down to its verb, which reads those it knows.
    const chain = [root];
    const path: string[] = [];
    let spec: Flags | undefined;
    for (;;) {
      const level = chain[chain.length - 1] as Command.Command.Any;
      if (level.subcommands.length === 0) break;
      let at = 0;
      if (FLAGS_FIRST.has(path.join(" "))) {
        spec = namespaceFlags(chain);
        at = (yield* parse(tokens, spec)).first;
        if (at === -1) break;
      }
      const word = tokens[at];
      if (word === undefined) break;
      const next = subcommand(level, word);
      if (next === undefined) {
        return yield* refuse(unknownCommand(path, word, binaryName));
      }
      chain.push(next);
      path.push(next.name);
      tokens.splice(at, 1);
    }

    const own = flagsOf(chain);
    const { values, positionals } = yield* parse(tokens, spec ?? own);
    positionals.push(...(line.past ?? []));
    const flagArgs = [...values]
      .filter(([name]) => own.has(name))
      .flatMap(([name, value]) =>
        value === true
          ? [`--${name}=true`]
          : value.map((each) => `--${name}=${each}`),
      );
    // Past `--`, effect/cli reads a positional as it is, as only a flag
    // could be read otherwise.
    return [
      ...path,
      ...flagArgs,
      ...(positionals.some(isFlag) ? ["--", ...positionals] : positionals),
    ];
  });
