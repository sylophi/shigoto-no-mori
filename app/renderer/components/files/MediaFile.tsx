import { useState } from "react";
import { CenteredMessage } from "@/components/ui/centered-message";

// An image, video or audio file, drawn by Chromium itself. One it
// can't decode (a codec it lacks, or bytes that aren't what the
// extension says) gets a line instead of a broken frame.
export function MediaFile({ mime, src }: { mime: string; src: string }) {
  // The source that failed, so another (another file, or this one
  // saved again) gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) {
    return <CenteredMessage>Can't show this file here.</CenteredMessage>;
  }
  const onError = () => setFailed(src);
  return (
    <div className="flex h-full items-center justify-center p-4">
      {mime.startsWith("video/") ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a file in a worktree comes with no captions to offer
        <video
          src={src}
          controls
          onError={onError}
          className="max-h-full max-w-full"
        />
      ) : mime.startsWith("audio/") ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a file in a worktree comes with no captions to offer
        <audio src={src} controls onError={onError} />
      ) : (
        <img
          src={src}
          alt=""
          onError={onError}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}
