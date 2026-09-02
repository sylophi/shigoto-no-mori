// The inline port editor, for adding a port and for editing a custom
// one in place: a number and an optional label. It sits where the row
// is (or will be), so neither act leaves the section. Enter submits,
// Escape cancels, and a number already on the list is refused with the
// reason rather than silently merged.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { errorMessageOf } from "@shared/errors";
import {
  digitsOnly,
  PORT_LABEL_MAX,
  parsePortNumber,
  type CustomPort,
  type WorktreePort,
} from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

export function PortForm({
  initial,
  taken,
  onSubmit,
  onDone,
  className,
}: {
  // Present when editing an existing custom port, which is then
  // exempt from the duplicate check against itself.
  initial?: CustomPort;
  taken: readonly WorktreePort[];
  onSubmit: (entry: CustomPort) => Promise<unknown>;
  onDone: () => void;
  className?: string;
}) {
  const [port, setPort] = useState(initial ? String(initial.port) : "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form opens on a click (Add port, Edit), so the number field
  // takes focus on mount: the click was the intent to type one.
  const portField = useRef<HTMLInputElement>(null);
  useEffect(() => portField.current?.focus(), []);
  // Escape anywhere in the form abandons it.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onDone();
  };

  const parsed = parsePortNumber(port);
  const validate = (): string | null => {
    if (parsed === undefined) return "Enter a port between 1 and 65535.";
    if (parsed === initial?.port) return null;
    const existing = taken.find((entry) => entry.port === parsed);
    if (existing !== undefined) {
      return existing.source === "pool"
        ? `port-pool already lists ${parsed}${existing.label ? ` as ${existing.label}` : ""}.`
        : `${parsed} is already on the list.`;
    }
    return null;
  };

  const submit = async () => {
    const problem = validate();
    if (problem !== null || parsed === undefined) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const trimmed = label.trim();
      await onSubmit({
        port: parsed,
        label: trimmed.length > 0 ? trimmed : undefined,
      });
      onDone();
    } catch (err) {
      setError(errorMessageOf(err));
      setSaving(false);
    }
  };

  return (
    <form
      className={cn("flex flex-col gap-1.5", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={portField}
          inputMode="numeric"
          value={port}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setError(null);
            setPort(digitsOnly(event.target.value));
          }}
          placeholder="Port"
          aria-label="Port number"
          className="tabular h-6 w-20 px-2 font-mono text-xs"
        />
        <Input
          value={label}
          onKeyDown={onKeyDown}
          maxLength={PORT_LABEL_MAX}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label (optional)"
          aria-label="Label"
          className="h-6 w-40 px-2 text-xs"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="secondary"
            size="xs"
            disabled={saving || port.length === 0}
          >
            {saving ? (
              <Loader2 className="animate-spin" />
            ) : initial ? (
              "Save"
            ) : (
              "Add"
            )}
          </Button>
        </div>
      </div>
      {error !== null && (
        <p className={cn("text-[11px]", TONE_TEXT.rose)}>{error}</p>
      )}
    </form>
  );
}
