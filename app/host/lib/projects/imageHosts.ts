// The hosts of this machine's projects' remotes, which images in their
// markdown may load from beside GitHub's (contracts'
// predicates/imageHosts.ts): what the window's Content-Security-Policy
// names, so an enterprise GitHub's attachments show.
import { pickCloneUrl } from "@shared/cloneUrl";
import {
  GITHUB_IMAGE_HOSTS,
  remoteHost,
} from "@shigomori/contracts/predicates/imageHosts";
import * as Effect from "effect/Effect";
import { listRemoteEntries } from "../git/remotes";
import { freshProjects } from "./index";

export const projectImageHosts = Effect.gen(function* () {
  const projects = yield* freshProjects;
  const hosts = yield* Effect.forEach(
    projects,
    (project) =>
      listRemoteEntries(project.path).pipe(
        Effect.map((remotes) => {
          const url = pickCloneUrl(remotes);
          return url === null ? null : remoteHost(url);
        }),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 8 },
  );
  return [
    ...new Set(
      hosts.filter(
        (host): host is string =>
          host !== null &&
          !GITHUB_IMAGE_HOSTS.some(
            (github) => host === github || host.endsWith(`.${github}`),
          ),
      ),
    ),
  ].toSorted();
});
