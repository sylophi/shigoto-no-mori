// The containers (renderer/components): every component there binds
// data to views, which live in @shigomori/ui (app/DESIGN.md, "Views and
// containers"), so none has markup of its own.
//
// covers: app/renderer/components/**
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { appRoot, stripComments, walk } from "./lib/checkKit.mts";

// An intrinsic element opening (<div, <span ...>), not a type argument
// (useState<string>), which follows an identifier.
const MARKUP = /(?:^|[^\w$.])<([a-z][\w-]*)[\s/>]/m;

it("keeps markup out of containers", () => {
  const root = join(appRoot, "renderer", "components");
  const offenders: string[] = [];
  for (const file of walk(root, /\.tsx$/)) {
    const path = relative(root, file);
    const tag = MARKUP.exec(stripComments(readFileSync(file, "utf8")));
    if (tag) offenders.push(`${path} <${tag[1]}>`);
  }
  expect(offenders, "containers with markup").toEqual([]);
});
