// The mirror's first step: the shared review (flow/PullReview.tsx) in
// the mirror's words, the original beside the copy.
import { PullReviewStep, type PullReviewProps } from "../flow/PullReview";

export function MirrorReview(props: PullReviewProps) {
  return (
    <PullReviewStep
      {...props}
      link="mirror"
      sourceHeading="Original"
      destinationHeading="Copy"
      idleNote=""
      startLabel="Start mirroring"
    />
  );
}
