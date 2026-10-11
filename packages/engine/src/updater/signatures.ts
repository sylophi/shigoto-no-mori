// The updater's signatures: a download's code signature and its team, checked before it is staged.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { type Anchor, SignatureRejected } from "./documents.ts";
import type { FilesArea } from "./files.ts";

export const makeSignatures = ({ files }: { readonly files: FilesArea }) =>
  Effect.sync(() => {
    const { run } = files;
    // --- signatures ---

    const signerOf = Effect.fn("Updater.signerOf")(function* (bundle: string) {
      const shown = yield* run("codesign", ["-dvv", "--", bundle]);
      if (!shown.ok) {
        return yield* new SignatureRejected({
          reason: "unreadable",
          bundle,
          cause: new Error(shown.output.trim()),
        });
      }
      const match = /(?:^|\n)TeamIdentifier=([^\n]+)/.exec(shown.output);
      if (match === null) {
        return yield* new SignatureRejected({
          reason: "no-team-identifier",
          bundle,
        });
      }
      const team = (match[1] ?? "").trim();
      const identifier = /(?:^|\n)Identifier=([^\n]+)/.exec(shown.output);
      return {
        team: team === "not set" ? "" : team,
        identifier: (identifier?.[1] ?? "").trim(),
      };
    });

    // The installed bundle for a run, its signer read at most once.
    const anchorOf = (bundle: string) =>
      Effect.map(
        Effect.cached(signerOf(bundle)),
        (signer): Anchor => ({ bundle, signer }),
      );

    // A valid deep, strict signature from a certificate Apple issued, the
    // installed app's Team ID, and the installed app's identifier, so a
    // release of another flavor is no update for this one. An unsigned
    // installed app refuses too: with no anchor there is nothing to
    // trust, and release builds are always signed. The checks run at
    // once, and fail in the order Go's sm made them, the identifier last.
    const verify = Effect.fn("Updater.verify")(function* (
      installed: Anchor,
      candidate: string,
    ) {
      const [checked, installedSigner, signer] = yield* Effect.all(
        [
          run("codesign", [
            "--verify",
            "--deep",
            "--strict",
            "-R=anchor apple generic",
            "--",
            candidate,
          ]),
          Effect.result(installed.signer),
          Effect.result(signerOf(candidate)),
        ],
        { concurrency: "unbounded" },
      );
      if (!checked.ok) {
        return yield* new SignatureRejected({
          reason: "invalid",
          bundle: candidate,
          cause: new Error(checked.output.trim()),
        });
      }
      if (Result.isFailure(installedSigner)) {
        return yield* installedSigner.failure;
      }
      if (Result.isFailure(signer)) return yield* signer.failure;
      const ours = installedSigner.success;
      const theirs = signer.success;
      if (ours.team === "") {
        return yield* new SignatureRejected({
          reason: "installed-unsigned",
          bundle: installed.bundle,
        });
      }
      if (theirs.team !== ours.team) {
        return yield* new SignatureRejected({
          reason: "other-team",
          bundle: candidate,
          team: theirs.team,
          installedTeam: ours.team,
        });
      }
      if (theirs.identifier !== ours.identifier) {
        return yield* new SignatureRejected({
          reason: "other-app",
          bundle: candidate,
          identifier: theirs.identifier,
          installedIdentifier: ours.identifier,
        });
      }
    });

    return { signerOf, anchorOf, verify };
  });

export type SignaturesArea = Effect.Success<ReturnType<typeof makeSignatures>>;
