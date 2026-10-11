import assert from "node:assert/strict";
import { it } from "vitest";
import {
  findJustfile,
  findMakefile,
  findPackageJson,
  parseJustfile,
  parseMakefile,
} from "../src/scriptFiles.ts";

it("finds each runner's file by its own lookup rules", () => {
  assert.equal(findJustfile(["README", ".JustFile"]), ".JustFile");
  assert.equal(findJustfile(["Justfile"]), "Justfile");
  assert.equal(findJustfile(["justfile.bak"]), undefined);
  assert.equal(
    findMakefile(["Makefile", "makefile", "GNUmakefile"]),
    "GNUmakefile",
  );
  assert.equal(findMakefile(["Makefile", "makefile"]), "makefile");
  assert.equal(findMakefile(["MAKEFILE"]), undefined);
  assert.equal(findPackageJson(["Package.json"]), undefined);
  assert.equal(findPackageJson(["package.json"]), "package.json");
});

it("lists a justfile's public recipes in file order", () => {
  const raw = `set shell := ["bash", "-c"]
version := "1.0"
alias b := build

# Builds it
build target="all":
    @echo building {{target}}
    go build ./...

[private]
helper:
    echo hidden

_also-hidden:
    echo hidden

[group('ci')]
test: build
@quiet:
\t-echo quiet
build:
    echo duplicate

[group('private-tools')]
deploy:
    echo deploy
[no-cd, private]
hidden:
    echo hidden
serve addr="localhost:8080": deploy
`;
  assert.deepEqual(parseJustfile(raw), [
    {
      name: "just build",
      command: "echo building {{target}}; go build ./...",
      label: "build",
      runner: "just",
    },
    { name: "just test", command: "build", label: "test", runner: "just" },
    {
      name: "just quiet",
      command: "echo quiet",
      label: "quiet",
      runner: "just",
    },
    {
      name: "just deploy",
      command: "echo deploy",
      label: "deploy",
      runner: "just",
    },
    { name: "just serve", command: "deploy", label: "serve", runner: "just" },
  ]);
});

const make = (label: string, command: string) => ({
  name: `make ${label}`,
  command,
  label,
  runner: "make",
});

it("lists a Makefile's named targets in file order, each with its first recipe", () => {
  const raw =
    "CC := gcc\n" +
    "FLAGS = -a:b\n" +
    ".PHONY: build test\n" +
    "\n" +
    "build: deps\n" +
    "\t@echo building\n" +
    "\t# a comment line\n" +
    "\tgo build \\\n" +
    "\t  ./...\n" +
    "\n" +
    "test: build ; go test ./...\n" +
    "lint fmt:\n" +
    "\t-golangci-lint run\n" +
    "main.o: main.c\n" +
    "\t$(CC) -c main.c\n" +
    "%.o: %.c\n" +
    "\t$(CC) -c $<\n" +
    "debug: FLAGS += -g\n" +
    "deps:\n" +
    "define TEMPLATE\n" +
    "inside: rule\n" +
    "endef\n" +
    "export define EXPORTED\n" +
    "inside2: rule\n" +
    "endef\n" +
    "$(error GOPATH is not set: run go env)\n" +
    "gen proto &: schema\n" +
    "\tprotoc schema\n" +
    "deps:\n" +
    "\tgo mod download\n";
  assert.deepEqual(parseMakefile(raw), [
    make("build", "echo building; go build ./..."),
    make("test", "go test ./..."),
    make("lint", "golangci-lint run"),
    make("fmt", "golangci-lint run"),
    make("deps", "go mod download"),
    make("gen", "protoc schema"),
    make("proto", "protoc schema"),
  ]);
});

it("leaves out a target named like one of make's options", () => {
  const raw = "--file=other:\n\techo no\n-j:\n\techo no\nbuild:\n\techo yes\n";
  assert.deepEqual(
    parseMakefile(raw).map(({ label }) => label),
    ["build"],
  );
});
