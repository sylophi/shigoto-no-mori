// The process's settings from its environment, for code that is not
// Effect yet (EFFECT.md, section 3): read through Effect's Config, so
// unset and empty read alike. The provider is made per read: the
// packaged app rebuilds its environment from the login shell after the
// first reads (host/lib/util/shellEnv.ts), and a provider made before that
// would answer with the launch environment.
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const envSetting = (name: string): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      Config.String(name).pipe(Config.option).parse(ConfigProvider.fromEnv()),
    ),
  );
