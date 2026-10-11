// The doctor's reads of the 2.x files, while the store can't import them.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ConfigDoc } from "../configDoc.ts";
import * as Paths from "../Paths.ts";
import { StoreImportError } from "../migrations/importJson.ts";
import { errnoText, isAbsent } from "../platformErrors.ts";
import { collapseHome } from "../shellHook.ts";
import {
  type Entry,
  type FileReads,
  type JsonFile,
  JsonObjectText,
  ProjectOrder,
  RegistryProjects,
  check,
} from "./documents.ts";
import type { DataDirChecksArea } from "./dataDirChecks.ts";

export const makeFileReads = ({
  dataDirChecks,
}: {
  readonly dataDirChecks: DataDirChecksArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const { home, dataDir } = paths;
    const {
      configFile,
      registryFile,
      checkGlobalConfig,
      registryLine,
      registeredLine,
    } = dataDirChecks;
    // --- the 2.x files, while the store can't import them ---

    const stateFile = path.join(dataDir, "state.json");

    // A JSON file the store imports, read as Go read it.
    const readJsonFile = (file: string) =>
      Effect.gen(function* () {
        const text = yield* Effect.result(fs.readFileString(file));
        if (Result.isFailure(text)) {
          return isAbsent(text.failure)
            ? ({ state: "absent" } satisfies JsonFile)
            : ({
                state: "unreadable",
                why: `open ${file}: ${errnoText(text.failure)}`,
              } satisfies JsonFile);
        }
        return Option.match(Schema.decodeOption(JsonObjectText)(text.success), {
          onNone: (): JsonFile => ({ state: "invalid" }),
          onSome: (doc): JsonFile => ({ state: "parsed", doc }),
        });
      });

    // config.json's line, read from the file.
    const configFromFile = Effect.gen(function* () {
      const line = check("Data dir", "config", "config.json");
      const found: JsonFile = yield* readJsonFile(configFile);
      switch (found.state) {
        case "absent":
          return checkGlobalConfig(Option.none());
        case "unreadable":
          return line.fail(
            `unreadable: ${found.why}`,
            `Fix the permissions on ${collapseHome(home, configFile)}.`,
          );
        case "invalid":
          return line.fail(
            "isn't valid JSON, so every global preference is silently ignored",
            `Repair the JSON in ${collapseHome(home, configFile)}, or delete it to fall back to defaults.`,
          );
        case "parsed":
          return checkGlobalConfig(Option.some(found.doc));
      }
    });

    // A registry document's line and projects, as Go judged registry.json:
    // the projects list, then the manual order, then each entry.
    const judgeRegistry = (doc: ConfigDoc, file: string) => {
      const projects = Schema.decodeUnknownOption(RegistryProjects)(
        doc["projects"],
      );
      if (Option.isNone(projects)) {
        return {
          entry: registryLine.fail(
            "the projects list has the wrong shape, so no project resolves",
            `Repair the projects array in ${collapseHome(home, file)}.`,
          ),
          projects: [],
        };
      }
      const listed = projects.value ?? [];
      if (
        Option.isNone(
          Schema.decodeUnknownOption(ProjectOrder)(doc["projectOrder"]),
        )
      ) {
        return {
          entry: registryLine.warn(
            "the projectOrder list has the wrong shape, so projects list in their default order and can't be reordered",
            `Repair or delete the projectOrder key in ${collapseHome(home, file)}.`,
          ),
          projects: listed,
        };
      }
      return { entry: registeredLine(listed, file), projects: listed };
    };

    // registry.json's line and its projects, read from the file.
    const registryFromFile = Effect.gen(function* () {
      const found: JsonFile = yield* readJsonFile(registryFile);
      switch (found.state) {
        case "absent":
          return {
            entry: registryLine.ok("absent, so no projects are registered yet"),
            projects: [],
          };
        case "unreadable":
          return {
            entry: registryLine.fail(
              `unreadable: ${found.why}`,
              `Fix the permissions on ${collapseHome(home, registryFile)}.`,
            ),
            projects: [],
          };
        case "invalid":
          return {
            entry: registryLine.fail(
              "isn't valid JSON, so every registered project is invisible to sm and the app",
              `Repair the JSON in ${collapseHome(home, registryFile)} (it holds the project registry).`,
            ),
            projects: [],
          };
        case "parsed":
          return judgeRegistry(found.doc, registryFile);
      }
    });

    // state.json holds only use history, so one that can't be read is a
    // warning.
    const stateFromFile = Effect.gen(function* () {
      const line = check("Data dir", "state", "state.json");
      const found: JsonFile = yield* readJsonFile(stateFile);
      const unusable = (why: string) => [
        line.warn(
          `can't be used (${why}), so use counts and view preferences are lost and nothing new is recorded`,
          `Repair ${collapseHome(home, stateFile)}, or delete it. It holds only that history.`,
        ),
      ];
      switch (found.state) {
        case "absent":
          return [];
        case "unreadable":
          return unusable(
            `Couldn't read ${collapseHome(home, stateFile)}: ${found.why}`,
          );
        case "invalid":
          return unusable(
            `${collapseHome(home, stateFile)} is not valid JSON. Fix the file or move it aside, then retry.`,
          );
        case "parsed":
          return [line.ok("valid")];
      }
    });

    // A registered project's project.json, which the store reads as
    // strictly as the registry: a line when it can't.
    const projectFileLine = (id: string, name: string) =>
      Effect.gen(function* () {
        const file = path.join(dataDir, "projects", id, "project.json");
        const line = check("Projects", "project-config", name);
        const found: JsonFile = yield* readJsonFile(file);
        switch (found.state) {
          case "unreadable":
            return Option.some(
              line.fail(
                `project.json can't be read (${found.why}), so the store can't import it and no command can run`,
                `Fix the permissions on ${collapseHome(home, file)}.`,
              ),
            );
          case "invalid":
            return Option.some(
              line.fail(
                "project.json exists but is invalid (bad JSON), so the store can't import it and no command can run",
                `Repair the JSON in ${collapseHome(home, file)}.`,
              ),
            );
        }
        return Option.none<Entry>();
      });

    // The lines that judge the 2.x files, for a store whose import
    // refused one of them. A refused file none of them names (a folder it
    // couldn't list, say) is the store's own line.
    const readFiles = (refused: StoreImportError) =>
      Effect.gen(function* () {
        const registered = yield* registryFromFile;
        const projectFiles = new Map<string, Entry>();
        for (const { id, name } of registered.projects) {
          if (id === undefined || id === "") continue;
          const line = yield* projectFileLine(id, name ?? id);
          if (Option.isSome(line)) projectFiles.set(id, line.value);
        }
        const named =
          [registryFile, stateFile, configFile].includes(refused.path) ||
          [...projectFiles.keys()].some(
            (id) =>
              path.join(dataDir, "projects", id, "project.json") ===
              refused.path,
          );
        return {
          config: yield* configFromFile,
          registry: registered.entry,
          state: yield* stateFromFile,
          refused: named
            ? []
            : [
                check("Data dir", "store", "store").fail(
                  `${collapseHome(home, refused.path)} can't be read into the store, so no command can run`,
                  "Fix its permissions, or move it aside.",
                ),
              ],
          projectFiles,
        } satisfies FileReads;
      }).pipe(Effect.provideContext(platform));

    return { readFiles };
  });

export type FileReadsArea = Effect.Success<ReturnType<typeof makeFileReads>>;
