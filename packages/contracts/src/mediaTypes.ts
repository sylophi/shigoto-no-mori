// The images, videos and audio the renderer's Chromium draws, by
// extension. SVG stays out: it is text, and its source is what a code
// viewer is for. A .mov goes as MP4, the container it shares: Chromium
// turns away video/quicktime even when it can play what's inside.
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

// The media type a path's extension names, when it is one of those.
export function mediaTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  // Past the name's first character, as for extname: ".png" has none.
  if (dot <= path.lastIndexOf("/") + 1) return undefined;
  return MEDIA_TYPES[path.slice(dot).toLowerCase()];
}
