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

    // A valid deep, strict signature that satisfies one requirement made
    // from the installed app: a certificate Apple issued, to the installed
    // app's team, for the installed app's identifier. So a release of
    // another flavor, another team's or one signed outside Apple's chain
    // is no update for this one. An installed app with no team or no
    // identifier refuses: with no anchor there is nothing to trust, and
    // release builds always have both. The candidate's own team and
    // identifier are read too, to say which one differed.
    const verify = Effect.fn("Updater.verify")(function* (
      installed: Anchor,
      candidate: string,
    ) {
      const ours = yield* installed.signer;
      if (ours.team === "" || !/^[A-Z0-9]+$/.test(ours.team)) {
        return yield* new SignatureRejected({
          reason: "installed-unsigned",
          bundle: installed.bundle,
        });
      }
      if (!/^[A-Za-z0-9.-]+$/.test(ours.identifier)) {
        return yield* new SignatureRejected({
          reason: "no-identifier",
          bundle: installed.bundle,
        });
      }
      const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${ours.team}" and identifier "${ours.identifier}"`;
      const [checked, signer] = yield* Effect.all(
        [
          run("codesign", [
            "--verify",
            "--deep",
            "--strict",
            `-R=${requirement}`,
            "--",
            candidate,
          ]),
          Effect.result(signerOf(candidate)),
        ],
        { concurrency: "unbounded" },
      );
      if (Result.isFailure(signer)) return yield* signer.failure;
      const theirs = signer.success;
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
      if (!checked.ok) {
        return yield* new SignatureRejected({
          reason: "invalid",
          bundle: candidate,
          cause: new Error(checked.output.trim()),
        });
      }
    });

    return { signerOf, anchorOf, verify };
  });

export type SignaturesArea = Effect.Success<ReturnType<typeof makeSignatures>>;
