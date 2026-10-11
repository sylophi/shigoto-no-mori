// What the app's guide leaves to the user (app/main/core/guide/Guide.ts):
// an agent showing the user the app may point at these but never click,
// type into or press a key on them. Declared on the control, or on an
// element around it, so the guide reads the page's own word rather than
// guessing from names. The reasons: a control that deletes, removes or
// signs out (every destructive variant carries it), one that hands the
// account's other devices this machine (the access switches), and the
// app's terminals.
export const USERS_ALONE = "data-users-alone";

export type UsersAloneReason = "destructive" | "access" | "terminal";

export const usersAlone = (reason: UsersAloneReason) => ({
  [USERS_ALONE]: reason,
});

// A destructive variant's mark, none for any other.
export const destructiveMark = (variant: string | null | undefined) =>
  variant?.endsWith("destructive") === true ? usersAlone("destructive") : {};
