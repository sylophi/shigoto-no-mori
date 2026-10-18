// The ports port-pool provisioned for a worktree, read back out of the
// env files it wrote rather than out of port-pool's own state: the
// files are the contract both sides agree on.

import { parseEnv } from "node:util";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// A port name, the port it holds, and where it was found.
export type PortInfo = {
  readonly name: string;
  readonly port: number;
  readonly file: string;
  readonly key: string;
};

// port-pool.config.json: which port names the project allocates, and
// the env files (variable name to template) port-pool writes them into.
// schemaVersion's presence is what marks the file as a real port-pool
// config rather than something else parked at that path.
export type PortPoolConfig = {
  readonly configured: boolean;
  readonly portNames: ReadonlyArray<string>;
  readonly envFiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

export const PORT_POOL_CONFIG = "port-pool.config.json";

const decodeDocument = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodePortNames = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const decodeEnvFiles = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);

// Key by key, tolerantly: "is this worktree configured" is what
// provision and release both hinge on, and a portNames or envFiles shape
// this build doesn't model must not turn it into a no, since release
// would then skip and leak the worktree's ports. Unreadable text reads
// as no config at all.
export function parsePortPoolConfig(text: string | undefined): PortPoolConfig {
  const doc = text === undefined ? Option.none() : decodeDocument(text);
  if (Option.isNone(doc)) {
    return { configured: false, portNames: [], envFiles: {} };
  }
  return {
    configured: "schemaVersion" in doc.value,
    portNames: Option.getOrElse(
      decodePortNames(doc.value["portNames"]),
      () => [],
    ),
    envFiles: Option.getOrElse(
      decodeEnvFiles(doc.value["envFiles"]),
      () => ({}),
    ),
  };
}

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const escaped = (literal: string) =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A template naming one declared port once ("${web}",
// "http://localhost:${api}"), as the name and a pattern whose one group
// is the value written in its place: Go's Atoi, an optional sign and
// digits. Null for any other template, whose value can't be read back.
const reversed = (template: string, names: ReadonlySet<string>) => {
  const found = [...template.matchAll(PLACEHOLDER)];
  const [only] = found;
  if (found.length !== 1 || only === undefined) return null;
  const name = only[1] ?? "";
  if (!names.has(name)) return null;
  const before = template.slice(0, only.index);
  const after = template.slice(only.index + only[0].length);
  return {
    name,
    pattern: new RegExp(`^${escaped(before)}([+-]?\\d+)${escaped(after)}$`),
  };
};

// The value each declared port name holds in the env files `files`
// (name to content), read back through a template that names it once,
// alone or inside literal text (a URL). The first file, then the first
// variable, to carry a name wins.
export function matchPorts(
  config: PortPoolConfig,
  files: ReadonlyMap<string, string>,
): PortInfo[] {
  const names = new Set(config.portNames);
  const ports: PortInfo[] = [];
  const seen = new Set<string>();
  for (const file of Object.keys(config.envFiles).toSorted()) {
    const content = files.get(file);
    if (content === undefined) continue;
    const env = parseEnv(content);
    const vars = config.envFiles[file] ?? {};
    for (const key of Object.keys(vars).toSorted()) {
      const template = reversed(vars[key] ?? "", names);
      if (template === null || seen.has(template.name)) continue;
      const raw = template.pattern.exec(env[key] ?? "")?.[1];
      if (raw === undefined) continue;
      const port = Number.parseInt(raw, 10);
      if (port <= 0) continue;
      seen.add(template.name);
      ports.push({ name: template.name, port, file, key });
    }
  }
  return ports;
}
