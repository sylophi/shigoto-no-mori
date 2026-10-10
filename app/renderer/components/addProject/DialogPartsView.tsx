import type {
  ComponentProps,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { Command } from "cmdk";
import { FolderInput, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup, KbdHint } from "@/components/ui/kbd";
import { PathSpan } from "@/components/ui/path-span";
import { SimpleTooltip, type WithoutTitle } from "@/components/ui/tooltip";

// The clone's and the new repository's top row: what to make, and the
// button that makes it, the way the folder browser's row reads. Inside
// a cmdk Command (`combobox`), the input is the list's, and ↑↓ move
// through it.
export function ActionInputRowView({
  value,
  onChange,
  placeholder,
  inputRef,
  icon,
  label,
  canSubmit,
  onSubmit,
  combobox = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef: RefObject<HTMLInputElement | null>;
  icon: ReactNode;
  label: string;
  canSubmit: boolean;
  onSubmit: () => void;
  combobox?: boolean;
}) {
  const inputProps = {
    ref: inputRef,
    value,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      // Home and End move the caret, never a list's highlight.
      if (e.key === "Home" || e.key === "End") e.stopPropagation();
      // ↩ is the button's, never a highlighted row's.
      if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
      e.preventDefault();
      if (canSubmit) onSubmit();
    },
    placeholder,
    "aria-label": placeholder,
    className:
      "min-w-0 flex-1 bg-transparent py-1 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground",
  };
  return (
    <div
      data-slot="search-row"
      className="relative flex items-center gap-2 border-b border-border px-3 py-2"
    >
      {combobox ? (
        <Command.Input
          {...inputProps}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of this flow
          autoFocus
          onValueChange={onChange}
        />
      ) : (
        <input
          {...inputProps}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- focusing the input is the whole point of this flow
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <KeyedButtonView
        icon={icon}
        label={label}
        keys="↩"
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-label={`${label} (↩)`}
      />
    </div>
  );
}

// The dialog's primary action, with the key that also runs it.
export function KeyedButtonView({
  icon,
  label,
  keys,
  ...props
}: {
  icon?: ReactNode;
  label: string;
  keys: string;
} & WithoutTitle<ComponentProps<"button">>) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      {...props}
    >
      {icon}
      <span>{label}</span>
      <KbdGroup className="pointer-events-none">
        <Kbd>{keys}</Kbd>
      </KbdGroup>
    </button>
  );
}

// Where a new checkout lands, and the way to put it somewhere else.
// The folder opens on where the device already keeps its repos
// (cloneDestination.ts), so the common case needs no pick.
export function DestinationRowView({
  dest,
  onChangeParent,
}: {
  // Already tildified by the caller.
  dest: string;
  onChangeParent: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <FolderInput className="size-4 shrink-0 text-muted-foreground/80" />
      <PathSpan
        path={dest}
        // Nothing left to tildify. PathSpan is here to shorten to fit.
        home={null}
        className="min-w-0 flex-1 truncate font-mono"
      />
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onChangeParent}
      >
        Change folder
      </Button>
    </div>
  );
}

// The clone's and the new repository's footer: the key that submits,
// and the options that ride along (the terrier opt-in).
export function FormFooterView({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="footer-row"
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
    >
      <KbdHint keys={["↩"]} label={label} />
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

// The dialog while a clone or a new repository is under way. No
// cancel: neither can be called back once the device has started it.
// Closing the dialog leaves it running, and the project shows up in the
// sidebar when it lands.
export function ProgressPanelView({
  icon,
  title,
  status,
  dest,
}: {
  icon: ReactNode;
  title: string;
  status: string;
  // Already tildified by the caller.
  dest: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        {icon}
        <SimpleTooltip whenTruncated tip={title}>
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            {title}
          </span>
        </SimpleTooltip>
      </div>
      <div className="flex flex-col items-center gap-3 px-4 py-14 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
        <span>{status}</span>
        {/* Spelled whole: PathSpan shortens to its box, and a centered
            line has none to measure. */}
        <span className="font-mono text-xs">{dest}</span>
      </div>
    </div>
  );
}
