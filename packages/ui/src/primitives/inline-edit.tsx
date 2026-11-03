import { useRef, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { Input } from "./input.tsx";

// The field is as tall as the line it stands in for. A title's and a
// subtitle's are pulled back by their padding and border so the text
// stays put: starting an edit doesn't move the page.
const SIZES = {
  title: {
    input: "-ml-2.25 h-8 px-2 py-0 text-2xl font-medium tracking-tight",
    button: "p-1.5",
    icon: "size-4",
  },
  subtitle: {
    input: "-ml-1.75 h-5.5 px-1.5 py-0 text-sm",
    button: "p-1",
    icon: "size-3.5",
  },
  sm: {
    input: "h-7 px-2 py-1 text-sm",
    button: undefined,
    icon: "size-3.5",
  },
} as const;

// A value edited in place. Enter saves, Esc cancels, and clicking away
// saves too. A blank or unchanged draft closes instead of saving, and
// the caller closes a save once it lands. `icons` sits beside the text
// it replaces with ✓ and ✕. `text` wears Save and Cancel and spells Esc
// out, for a field with no obvious edges.
export function InlineEdit({
  value,
  label,
  pending,
  onSave,
  onCancel,
  variant,
  size = "sm",
  sanitize,
  allowBlank = false,
  error,
  inputClassName,
}: {
  // The stored value, the draft's start.
  value: string;
  // The field's accessible name.
  label: string;
  pending: boolean;
  onSave: (next: string) => void;
  onCancel: () => void;
  variant: "icons" | "text";
  size?: keyof typeof SIZES;
  // Applied to every keystroke.
  sanitize?: (draft: string) => string;
  // Saves a blank draft rather than closing.
  allowBlank?: boolean;
  // Under the field, the save's failure.
  error?: ReactNode;
  inputClassName?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [seededFrom, setSeededFrom] = useState(value);

  // An untouched draft follows the stored value when it changes
  // underneath (another window, the save settling). One being typed in
  // stays the person's.
  if (value !== seededFrom) {
    setSeededFrom(value);
    if (draft === seededFrom) setDraft(value);
  }

  const next = draft.trim();
  const canSave = next !== value && (allowBlank || next !== "") && !pending;
  const save = () => {
    if (pending) return;
    if (canSave) onSave(next);
    else onCancel();
  };
  // Focus moving to the editor's own buttons isn't clicking away.
  const editor = useRef<HTMLSpanElement>(null);
  const { input, button, icon } = SIZES[size];

  const field = (
    <Input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the edit was just asked for
      autoFocus
      type="text"
      aria-label={label}
      value={draft}
      selectOutsideChanges
      disabled={pending}
      onChange={(event) =>
        setDraft(sanitize ? sanitize(event.target.value) : event.target.value)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (!editor.current?.contains(event.relatedTarget)) save();
      }}
      className={cn(
        "min-w-0",
        input,
        variant === "icons" && "flex-1",
        inputClassName,
      )}
    />
  );

  if (variant === "text") {
    return (
      <span
        ref={editor}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        {/* The hint is what wraps when room runs out. */}
        <span className="flex min-w-0 items-center gap-1.5">
          {field}
          <Button
            variant="outline"
            size="xs"
            disabled={!canSave}
            onClick={save}
            keys="↩"
          >
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        </span>
        <span className="text-3xs text-muted-foreground">Esc to cancel</span>
        {error && <span className="basis-full">{error}</span>}
      </span>
    );
  }

  return (
    // Grows to the room it's given, where a row has more beside it.
    <span
      ref={editor}
      className="flex min-w-0 grow flex-wrap items-center gap-2"
    >
      {field}
      <IconButton
        onClick={save}
        disabled={pending}
        aria-label="Save"
        className={button}
      >
        <Check className={icon} />
      </IconButton>
      <IconButton
        onClick={onCancel}
        disabled={pending}
        aria-label="Cancel"
        className={button}
      >
        <X className={icon} />
      </IconButton>
      {error && <span className="basis-full">{error}</span>}
    </span>
  );
}
