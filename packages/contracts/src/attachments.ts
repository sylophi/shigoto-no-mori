// What a new pull request's description takes as an attachment: an
// image or a video of a type gh uploads, within the size GitHub takes
// for its kind. The dialog checks a file by it before staging, and the
// host every staged chunk and every link it fetches.
import {
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_VIDEO_EXTENSIONS,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_VIDEO_BYTES,
} from "./schemas/pullRequest.ts";

// How the description refers to an attachment by its name, which is how
// gh's --attach finds where an uploaded file goes, and the host points
// at the staged copy.
export const attachmentReference = (name: string) => `./${name}`;

// The type a staged name stands for, by its extension (the dialog and
// the host name a file by its type's), or "" for one gh won't upload.
export function attachmentTypeOfName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const byExtension = (types: Readonly<Record<string, string>>) =>
    Object.keys(types).find((type) => types[type] === ext);
  return (
    byExtension(ATTACHMENT_IMAGE_EXTENSIONS) ??
    byExtension(ATTACHMENT_VIDEO_EXTENSIONS) ??
    ""
  );
}

// Why a file can't be attached, or null when it can. With no size yet
// (a link whose body hasn't come), only its type is checked.
export function attachmentRefusal(file: {
  name: string;
  type: string;
  size?: number;
}): string | null {
  const video = Object.hasOwn(ATTACHMENT_VIDEO_EXTENSIONS, file.type);
  if (!video && !Object.hasOwn(ATTACHMENT_IMAGE_EXTENSIONS, file.type)) {
    return `Only images and videos can be attached, and ${file.name} is neither`;
  }
  if (file.size === undefined) return null;
  if (file.size === 0) return `${file.name} is empty`;
  const max = video ? MAX_ATTACHMENT_VIDEO_BYTES : MAX_ATTACHMENT_IMAGE_BYTES;
  if (file.size > max) {
    return `${file.name} is over the ${max / 1024 / 1024} MB GitHub takes`;
  }
  return null;
}
