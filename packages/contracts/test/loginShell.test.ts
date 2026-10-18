import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { describe, it } from "vitest";
import { loginShellOf } from "../src/loginShell.ts";

const read = (
  environment: "own" | "launcher",
  shellVar: string,
  account: string,
) => {
  let asked = 0;
  const shell = Effect.runSync(
    loginShellOf({
      environment,
      shellVar,
      account: Effect.sync(() => {
        asked += 1;
        return account;
      }),
    }),
  );
  return { shell, asked };
};

describe("loginShellOf", () => {
  it("on a $SHELL/account mismatch takes $SHELL in the user's environment and the account's in a launcher's", () => {
    assert.deepEqual(read("own", "/bin/bash", "/bin/zsh"), {
      shell: "/bin/bash",
      asked: 0,
    });
    assert.deepEqual(read("launcher", "/bin/bash", "/bin/zsh"), {
      shell: "/bin/zsh",
      asked: 1,
    });
  });

  it("falls to the other reading when one names none, and to none", () => {
    assert.equal(read("own", "", "/bin/zsh").shell, "/bin/zsh");
    assert.equal(read("launcher", "/bin/bash", "").shell, "/bin/bash");
    assert.equal(read("own", "", "").shell, "");
    assert.equal(read("launcher", "", "").shell, "");
  });
});
