// Scope-aware navigation for the worktree detail tree. Every worktree
// page lives under /devices/$deviceId, so its internal links target the
// device the current host scope names. The paths themselves come from
// lib/routePaths so the route tree and these links cannot drift apart.
import { useNavigate, useParams } from "@tanstack/react-router";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { routeDeviceId, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { slotToParam, type ScriptSlot } from "@/store/scriptSlot";

// The worktree pages' params, read non-strictly because the pages
// share them across five routes (the router can only type params
// against ONE route). `hash` exists only under the commit page and
// `scriptKey` only under the console. Keeping the one unavoidable cast
// here gives the pages a single seam instead of a copy each.
export function useScopedWorktreeParams() {
  return useParams({ strict: false }) as {
    projectId: string;
    worktreeId: string;
    hash: string;
    scriptKey: string;
  };
}

type WorktreePage = keyof typeof WORKTREE_ROUTE_PATHS;

interface WorktreePageParams {
  projectId: string;
  worktreeId: string;
  hash?: string;
  scriptKey?: string;
}

export function useWorktreeNav() {
  const navigate = useNavigate();
  const { deviceId } = useHostScope();

  // `on` names the device whose page to open. The router can only
  // check params against ONE literal `to`, and this one is a union of
  // the pages, hence the single cast -- the paths come from the same
  // constants the route tree is built from, so a path the tree doesn't
  // serve still can't slip through.
  const goOn = (
    on: string,
    page: WorktreePage,
    params: WorktreePageParams,
    replace = false,
    search?: Record<string, unknown>,
  ) => {
    void navigate({
      to: WORKTREE_ROUTE_PATHS[page],
      params: { ...params, deviceId: on },
      ...(search === undefined ? {} : { search }),
      replace,
    } as never);
  };
  // The device the current host scope names.
  const go = (
    page: WorktreePage,
    params: WorktreePageParams,
    replace = false,
    search?: Record<string, unknown>,
  ) => goOn(deviceId, page, params, replace, search);

  return {
    toWorktree(projectId: string, worktreeId: string, replace = false) {
      go("detail", { projectId, worktreeId }, replace);
    },

    // `amend` opens the changes page already set to rewrite the last
    // commit; it lives in the route's search so the page and the row
    // menu that opens it agree on one source of truth.
    toDiff(
      projectId: string,
      worktreeId: string,
      opts: { amend?: boolean; replace?: boolean } = {},
    ) {
      go(
        "diff",
        { projectId, worktreeId },
        opts.replace ?? false,
        opts.amend ? { amend: true } : {},
      );
    },

    toCommit(projectId: string, worktreeId: string, hash: string) {
      go("commit", { projectId, worktreeId, hash });
    },

    toPrDiff(projectId: string, worktreeId: string) {
      go("prDiff", { projectId, worktreeId });
    },

    // The files page, opened on `path` when given (a file to show). A
    // pick on the page replaces its entry, so Back leaves the page
    // rather than stepping through every file looked at.
    toFiles(
      projectId: string,
      worktreeId: string,
      opts: { path?: string; replace?: boolean } = {},
    ) {
      go(
        "files",
        { projectId, worktreeId },
        opts.replace ?? false,
        opts.path === undefined ? {} : { path: opts.path },
      );
    },

    // The script's console, on the device this page is scoped to: a
    // run on a peer streams back over its direct session, so its
    // console is a page of that device like the diffs are.
    toScript(projectId: string, worktreeId: string, slot: ScriptSlot) {
      go("script", { projectId, worktreeId, scriptKey: slotToParam(slot) });
    },

    // Explicitly a NAMED device's page, whatever the surrounding scope:
    // a mirrored or transplanted worktree lands on this machine even
    // when the action ran from a peer's page, or on a peer even though
    // the action ran from a local one.
    toDeviceWorktree(landedOn: string, projectId: string, worktreeId: string) {
      goOn(landedOn, "detail", { projectId, worktreeId });
    },

    // Any worktree page on a NAMED machine, whatever the surrounding
    // scope: this one's for undefined (a row's spelling, routeDeviceId),
    // else that peer's. For a surface that spans every device at once
    // (the ⌘K palette).
    toPageOn(
      on: string | undefined,
      page: WorktreePage,
      params: WorktreePageParams,
    ) {
      goOn(routeDeviceId(on), page, params);
    },

    // Where "leave this worktree's pages" lands. The root for every
    // device: a peer's worktree has no place of its own to fall back
    // to, and the root is the merged tree's home either way (the web
    // shell's root dispatches to /devices).
    toFallback(replace = false) {
      void navigate({ to: "/", replace });
    },
  };
}
