import assert from "node:assert/strict";
import { it } from "vitest";
import {
  decodeConfig,
  encodeConfig,
  withHook,
  withoutHook,
} from "../src/shellHook.ts";

const names = { binary: "sm", alias: "shigomori" };

const profile = "Set-Alias g git\r\n# 日本語\r\n$env:EDITOR = 'code'\r\n";

const stored = {
  "UTF-8": Buffer.from(profile, "utf8"),
  "UTF-8 with a BOM": Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(profile, "utf8"),
  ]),
  "UTF-16 LE": Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(profile, "utf16le"),
  ]),
  // What Windows PowerShell 5.1's Set-Content writes: the code page.
  ANSI: Buffer.from("# caf\xe9\r\nSet-Alias g git\r\n", "latin1"),
};

for (const [encoding, bytes] of Object.entries(stored)) {
  it(`adds and removes the hook in a ${encoding} profile byte for byte`, () => {
    const file = decodeConfig(bytes);
    const hooked = decodeConfig(
      encodeConfig({ ...file, text: withHook(names, "powershell", file.text) }),
    );
    assert.equal(hooked.encoding, file.encoding);
    assert.ok(hooked.text.startsWith(file.text));
    assert.ok(!/[^\r]\n/.test(hooked.text));
    const unhooked = encodeConfig({
      ...hooked,
      text: withoutHook(names, hooked.text),
    });
    assert.ok(Buffer.from(unhooked).equals(bytes));
  });
}

it("adds an LF hook to a zsh rc with CRLF lines and removes it byte for byte", () => {
  const rc = "# edited on Windows\r\nexport EDITOR=vim\r\n";
  const hooked = withHook(names, "zsh", rc);
  assert.ok(hooked.startsWith(rc));
  assert.ok(!hooked.slice(rc.length).includes("\r"));
  assert.equal(withoutHook(names, hooked), rc);
});
