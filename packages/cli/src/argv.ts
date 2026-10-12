// The Go sm's parsing, in front of effect/cli's: flags and positionals
// interleave, any number of leading dashes name a flag (`-no-cd`), a
// valued flag takes the next argument whatever it is, the last of a
// repeated flag wins (a list flag keeps each), a boolean takes no value,
// and `--` makes the rest positional. The command line comes out in the
// one form effect/cli reads the same way: the command's names, each flag
// as `--name=value` (a boolean as `=true`, so no positional after it
// reads as its value), then the positionals. Each command's flags are
// read from its own definition.
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Command from "effect/cli/Command";
import * as Param from "effect/cli/Param";
import { UsageError } from "./errors.ts";

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

// Every flag the command at the end of `chain` reads, by name and alias:
// its own and the ones its ancestors share.
const flagsOf = (chain: ReadonlyArray<Command.Command.Any>) => {
  const index = new Map<string, Flag>();
  for (const [i, command] of chain.entries()) {
    const params = [
      ...(i === chain.length - 1 ? declared(command, "config") : []),
      ...declared(command, "contextConfig"),
    ];
    for (const flag of params.map((param) => flagOf(param))) {
      for (const name of [flag.name, ...flag.aliases]) index.set(name, flag);
    }
  }
  return index;
};

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

// The command line under `root` (its words after the binary's) as
// effect/cli is to read it, or the Go sm's refusal.
export const goArgs = (
  root: Command.Command.Any,
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, UsageError> =>
  Effect.suspend(() => {
    const end = args.indexOf("--");
    const tokens = end === -1 ? [...args] : args.slice(0, end);
    const after = end === -1 ? [] : args.slice(end + 1);

    // The command: each level's first positional, while it names one of
    // that level's subcommands.
    const chain = [root];
    const path: string[] = [];
    for (;;) {
      const level = chain[chain.length - 1] as Command.Command.Any;
      if (level.subcommands.length === 0) break;
      const flags = flagsOf(chain);
      let i = 0;
      while (i < tokens.length && isFlag(tokens[i] as string)) {
        const { name, inline } = split(tokens[i] as string);
        i += flags.get(name)?.valued === true && inline === undefined ? 2 : 1;
      }
      const word = tokens[i];
      const next = word === undefined ? undefined : subcommand(level, word);
      if (next === undefined) break;
      chain.push(next);
      path.push(next.name);
      tokens.splice(i, 1);
    }

    const flags = flagsOf(chain);
    const values = new Map<string, string[] | true>();
    const positionals: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const arg = tokens[i] as string;
      if (!isFlag(arg)) {
        positionals.push(arg);
        continue;
      }
      const { name, inline } = split(arg);
      const flag = flags.get(name);
      if (flag === undefined) {
        return Effect.fail(
          new UsageError({ problem: `Unknown option ${JSON.stringify(arg)}.` }),
        );
      }
      if (!flag.valued) {
        if (inline !== undefined) {
          return Effect.fail(
            new UsageError({
              problem: `Option ${JSON.stringify(arg)} takes no value.`,
            }),
          );
        }
        values.set(flag.name, true);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        i++;
        if (i >= tokens.length) {
          return Effect.fail(
            new UsageError({
              problem: `Option ${JSON.stringify(arg)} requires a value.`,
            }),
          );
        }
        value = tokens[i] as string;
      }
      const held = values.get(flag.name);
      values.set(
        flag.name,
        flag.list && Array.isArray(held) ? [...held, value] : [value],
      );
    }
    positionals.push(...after);

    const flagArgs = [...values].flatMap(([name, value]) =>
      value === true
        ? [`--${name}=true`]
        : value.map((each) => `--${name}=${each}`),
    );
    // Past `--`, effect/cli reads a positional as it is, as only a flag
    // could be read otherwise. Before it, a word may still be a level's
    // unknown subcommand.
    return Effect.succeed([
      ...path,
      ...flagArgs,
      ...(positionals.some(isFlag) ? ["--", ...positionals] : positionals),
    ]);
  });
