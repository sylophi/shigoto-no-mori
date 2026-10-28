import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { AlertCircle, Check, Film, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { Markdown } from "../../primitives/markdown.tsx";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { Textarea } from "../../primitives/textarea.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import {
  ATTACHMENT_ACCEPT,
  linkedImages,
  previewImages,
  previewSource,
  type Attachment,
} from "../../lib/pullRequestAttachments.ts";

type Tab = "write" | "preview";

const TABS = [
  { value: "write", label: "Write" },
  { value: "preview", label: "Preview" },
] as const;

// The description as GitHub's own form has it: markdown written in one
// tab and shown in the other, and, where it goes with attachments,
// images and videos pasted, dropped or picked into it, each landing at
// the caret as a reference while it uploads to the host beside the list
// of what's attached.
export function DescriptionEditorView({
  label = "Description",
  value,
  onChange,
  attach,
  disabled,
}: {
  // What it writes, said in its field and its tabs.
  label?: string;
  value: string;
  onChange: (next: string) => void;
  attach?: {
    attachments: readonly Attachment[];
    // Files, and images that came as links, to attach where the
    // selection is.
    onAttach: (
      incoming: { files: File[]; links: { url: string; alt: string }[] },
      selection: { start: number; end: number },
    ) => void;
    onRemove: (attachment: Attachment) => void;
  };
  disabled: boolean;
}) {
  const attachments = attach?.attachments ?? [];
  const [tab, setTab] = useState<Tab>("write");
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  const selection = () => {
    const el = textRef.current;
    return el
      ? { start: el.selectionStart, end: el.selectionEnd }
      : { start: value.length, end: value.length };
  };
  const attachFiles = (files: File[]) => {
    if (files.length > 0) attach?.onAttach({ files, links: [] }, selection());
  };
  // Files first. Without any, the images a page handed over as links
  // (an image dragged off it, or copied with its HTML), as long as
  // that's all it handed over: pasted text with an image in it pastes
  // its text, as it would anywhere.
  const take = (data: DataTransfer, e: { preventDefault: () => void }) => {
    if (!attach) return;
    const files = Array.from(data.files);
    if (files.length > 0) {
      e.preventDefault();
      attachFiles(files);
      return;
    }
    const { links, alone } = linkedImages(
      data.getData("text/html"),
      data.getData("text/uri-list"),
    );
    if (links.length === 0 || !alone) return;
    e.preventDefault();
    attach.onAttach({ files: [], links }, selection());
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) =>
    take(e.clipboardData, e);
  // Files land on the text or on its preview alike, the preview's at
  // the end of the text, where they then show.
  const dropZone = attach && {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const { types } = e.dataTransfer;
      if (!types.includes("Files") && !types.includes("text/uri-list")) {
        return;
      }
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent<HTMLElement>) => {
      setDragging(false);
      textRef.current?.focus();
      take(e.dataTransfer, e);
    },
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SegmentedControl
          aria-label={`${label} view`}
          optionClassName="px-2.5 py-0.5 text-xs"
          value={tab}
          onChange={setTab}
          options={TABS}
        />
        {attach && (
          <>
            <SimpleTooltip tip="Images and videos. Paste or drop them too">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto text-muted-foreground"
                disabled={disabled}
                onClick={() => {
                  setTab("write");
                  pickRef.current?.click();
                }}
              >
                <Paperclip aria-hidden />
                Attach files
              </Button>
            </SimpleTooltip>
            <input
              ref={pickRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                attachFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
      {/* What a drag over either says, laid over it without taking
          the drop. */}
      <div className="relative">
        {tab === "write" ? (
          <Textarea
            ref={textRef}
            aria-label={label}
            placeholder={`${label} (markdown)`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={onPaste}
            {...dropZone}
            disabled={disabled}
            className="min-h-48 w-full resize-y px-3 py-2 font-mono text-xs leading-relaxed"
          />
        ) : (
          <div
            {...dropZone}
            className="min-h-48 rounded-md bg-muted/40 px-3 py-2.5"
          >
            {value.trim() === "" ? (
              <p className="text-xs text-muted-foreground">
                Nothing to preview
              </p>
            ) : (
              <Markdown
                source={previewSource(value, attachments)}
                images={previewImages(attachments)}
              />
            )}
          </div>
        )}
        {dragging && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-primary/10 text-xs font-medium text-primary"
          >
            Drop to attach
          </div>
        )}
      </div>
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onRemove={() => attach?.onRemove(attachment)}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
  disabled,
}: {
  attachment: Attachment;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { status } = attachment;
  return (
    <li
      className={cn(
        "flex max-w-60 items-center gap-1.5 rounded-md bg-muted/60 py-0.5 pr-0.5 pl-1.5 text-xs",
        status === "failed" && "text-destructive",
      )}
    >
      {attachment.previewUrl ? (
        <img
          src={attachment.previewUrl}
          alt=""
          className="size-5 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <Film aria-hidden className="size-3.5 shrink-0" />
      )}
      <SimpleTooltip whenTruncated tip={attachment.label ?? attachment.name}>
        <span className="min-w-0 truncate font-mono">
          {attachment.label ?? attachment.name}
        </span>
      </SimpleTooltip>
      {status === "staging" ? (
        <Loader2
          aria-label="Uploading"
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        />
      ) : status === "failed" ? (
        <SimpleTooltip tip={attachment.error ?? "Couldn't upload"}>
          <AlertCircle
            aria-label="Couldn't upload"
            className="size-3.5 shrink-0"
          />
        </SimpleTooltip>
      ) : (
        <Check
          aria-label="Ready"
          className="size-3.5 shrink-0 text-emerald-500"
        />
      )}
      <IconButton
        aria-label={`Remove ${attachment.label ?? attachment.name}`}
        tone="destructive"
        className="p-0.5"
        onClick={onRemove}
        disabled={disabled}
      >
        <X aria-hidden className="size-3" />
      </IconButton>
    </li>
  );
}
