// What the app's guide leaves to the user (src/lib/usersAlone.ts),
// declared where the page draws it:
//   1. every control a destructive variant draws carries the mark, as
//      the primitives draw it and as every scene does;
//   2. the access switches, the terminal, and what runs code (a script's
//      Run, the launch tools, a script's or a launcher's command) carry
//      theirs.
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { USERS_ALONE } from "../src/lib/usersAlone.ts";
import { Button } from "../src/primitives/button.tsx";
import { IconButton } from "../src/primitives/icon-button.tsx";
import { scenes } from "../src/scenes/index.ts";
import { AcceptCommandsToggleView } from "../src/views/remote/AcceptCommandsToggleView.tsx";
import { ShareDataToggleView } from "../src/views/remote/ShareDataToggleView.tsx";
import { TerminalView } from "../src/views/terminal/TerminalView.tsx";
import { ScriptFieldView } from "../src/views/configure/ScriptFieldView.tsx";
import { CustomLauncherInputView } from "../src/views/shared/CustomLauncherInputView.tsx";
import { LaunchSectionView } from "../src/views/worktreeDetail/LaunchSectionView.tsx";
import { ScriptRowView } from "../src/views/worktreeDetail/scripts/ScriptRowView.tsx";

const html = (element: ReactElement) => renderToStaticMarkup(element);

// Every opening tag that names a destructive variant or tone, and
// whether it carries the mark. A checkbox's destructive variant only
// says what a selection is for: the button that acts on it is marked.
const destructiveTags = (markup: string) =>
  [...markup.matchAll(/<[a-z]+\b[^>]*data-variant="[a-z-]*destructive"[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => !tag.includes('data-slot="checkbox"'));

const marked = (tag: string, reason: string) =>
  tag.includes(`${USERS_ALONE}="${reason}"`);

it("marks every destructive variant the primitives draw", () => {
  for (const variant of [
    "destructive",
    "ghost-destructive",
    "outline-destructive",
  ] as const) {
    const markup = html(createElement(Button, { variant }, "Delete"));
    assert.ok(marked(markup, "destructive"), `${variant} is unmarked`);
  }
  assert.ok(
    marked(
      html(createElement(IconButton, { tone: "destructive" })),
      "destructive",
    ),
  );
  assert.ok(!html(createElement(Button, {}, "Save")).includes(USERS_ALONE));
});

it("marks every destructive control a scene draws", () => {
  const unmarked: string[] = [];
  let seen = 0;
  for (const [name, { Scene }] of Object.entries(scenes)) {
    for (const tag of destructiveTags(html(createElement(Scene)))) {
      seen += 1;
      if (!marked(tag, "destructive")) unmarked.push(`${name}: ${tag}`);
    }
  }
  assert.ok(seen > 0, "no scene drew a destructive control");
  assert.deepEqual(unmarked, []);
});

const noop = () => {};

it("marks the access switches and the terminal", () => {
  assert.ok(
    marked(
      html(
        createElement(AcceptCommandsToggleView, {
          enabled: false,
          isError: false,
          pending: false,
          onChange: noop,
        }),
      ),
      "access",
    ),
  );
  assert.ok(
    marked(
      html(
        createElement(ShareDataToggleView, {
          on: true,
          disabled: false,
          onChange: noop,
        }),
      ),
      "access",
    ),
  );
  assert.ok(
    marked(
      html(
        createElement(TerminalView, {
          feed: null,
          live: false,
          onInput: noop,
          onFit: noop,
          onLink: noop,
        }),
      ),
      "terminal",
    ),
  );
});

it("marks what runs code: a script's Run, the launch tools and the command fields", () => {
  const ran = {
    runId: null,
    status: "idle" as const,
    hasOutput: false,
    interactive: true,
    exitCode: null,
    startedAt: null,
    endedAt: null,
    cancelling: false,
  };
  for (const element of [
    createElement(ScriptRowView, {
      label: "dev",
      command: "vite",
      state: ran,
      busy: false,
      canRun: true,
      disabledReason: undefined,
      onRun: noop,
      onStop: noop,
      onOpenConsole: noop,
    }),
    createElement(LaunchSectionView, { tools: "Terminal", scripts: "dev" }),
    createElement(ScriptFieldView, {
      id: "script-setup",
      label: "Setup",
      value: "pnpm install",
      onChange: noop,
    }),
    createElement(CustomLauncherInputView, {
      launcher: { id: "a", label: "Shell", command: "devbox shell" },
      onChange: noop,
      onRemove: noop,
    }),
  ]) {
    assert.ok(marked(html(element), "run"), html(element).slice(0, 120));
  }
});
