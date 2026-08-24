import { useState } from "react";
import { Copy, Eye, RefreshCw } from "lucide-react";
import { DEFAULT_SOCKET_PORT } from "@shared/ipc/socket/frames";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";
import { ToggleRow } from "./ToggleRow";
import { useGlobalConfig } from "@/hooks/config/useGlobalConfig";
import { useLocalGlobalConfigUpdate } from "@/hooks/config/useLocalGlobalConfigUpdate";
import { toast } from "@/lib/toast";

// "This device (hosting)": the local machine serving its forest to
// remote clients over the websocket host transport. Display state (on,
// lan, port, whether a token is set) comes from the redacted read, which
// carries no token. The token itself is revealed on demand through an
// imperative unredacted read so it never sits in a cached query.
export function HostingSection() {
  const { data: config } = useGlobalConfig();
  const update = useLocalGlobalConfigUpdate("Couldn't update hosting");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  const socketHost = config?.socketHost;
  const enabled = socketHost?.enabled === true;
  const lan = socketHost?.lan === true;
  const effectivePort = socketHost?.port ?? DEFAULT_SOCKET_PORT;
  const tokenSet = socketHost?.tokenSet === true;
  const busy = update.isPending;

  const [portDraft, setPortDraft] = useState(String(effectivePort));

  const setEnabled = (next: boolean) => {
    setRevealed(null);
    update.mutate((base) =>
      next
        ? { ...base, socketHost: { ...base.socketHost, enabled: true } }
        : // Omit socketHost entirely so the whole-document write clears
          // every leaf (the token included) and the listener stops.
          dropSocketHost(base),
    );
  };

  const setLan = (next: boolean) => {
    update.mutate((base) => ({
      ...base,
      socketHost: { ...base.socketHost, lan: next },
    }));
  };

  const applyPort = () => {
    const parsed = Number.parseInt(portDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setPortDraft(String(effectivePort));
      return;
    }
    if (parsed === effectivePort) return;
    update.mutate((base) => ({
      ...base,
      socketHost: {
        ...base.socketHost,
        // Omit the key on the default so a bare default never persists.
        port: parsed === DEFAULT_SOCKET_PORT ? undefined : parsed,
      },
    }));
  };

  const regenerate = () => {
    setRevealed(null);
    // Drop the token while staying enabled: the host reconcile generates
    // a fresh one when hosting is on without a token.
    update.mutate((base) => ({
      ...base,
      socketHost: {
        enabled: base.socketHost?.enabled,
        lan: base.socketHost?.lan,
        port: base.socketHost?.port,
      },
    }));
  };

  const reveal = async () => {
    setRevealing(true);
    try {
      const doc = await window.api.globalConfig.readLocal();
      setRevealed(doc.socketHost?.token ?? "");
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">This device (hosting)</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Serve this machine&apos;s forest to another device on your network,
          read only. The other machine adds this device with the token below.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-sm">
          <span
            className={
              enabled
                ? "size-1.5 rounded-full bg-emerald-500"
                : "size-1.5 rounded-full bg-muted-foreground"
            }
          />
          {enabled ? "Listening" : "Off"}
        </span>
      </div>

      <ToggleRow
        checked={enabled}
        onCheckedChange={setEnabled}
        disabled={busy}
        label="Host this device"
        description="Binds to loopback only until you opt into LAN below."
      />

      {enabled && (
        <div className="space-y-3 border-t border-border pt-3">
          <ToggleRow
            checked={lan}
            onCheckedChange={setLan}
            disabled={busy}
            label="Expose on the local network (LAN)"
            description="Off by default the port is reachable only from this machine. Turning this on binds every network interface so other machines on your LAN can reach the port."
          />

          <div className="flex flex-wrap items-center gap-2">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="host-port"
            >
              Port
            </label>
            <Input
              id="host-port"
              type="text"
              inputMode="numeric"
              value={portDraft}
              disabled={busy}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={applyPort}
              aria-label="Hosting port"
              className="w-24 px-2.5 py-1.5 text-sm"
            />
            <span className="text-xs text-muted-foreground/70">
              default {DEFAULT_SOCKET_PORT}
            </span>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Token{" "}
              {tokenSet ? (
                <span className="text-emerald-500">set</span>
              ) : (
                <span className="text-amber-500">generating…</span>
              )}
              . Copy it to the other machine when adding this device.
            </p>
            {revealed !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="max-w-full truncate rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs select-text">
                  {revealed || "(no token yet)"}
                </span>
                {revealed && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copyToken(revealed)}
                  >
                    <Copy />
                    Copy
                  </Button>
                )}
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={revealing || !tokenSet}
                onClick={() => void reveal()}
              >
                <Eye />
                Reveal token
              </Button>
            )}
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={regenerate}
              >
                <RefreshCw />
                Regenerate token
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

async function copyToken(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast.success("Token copied");
}

// Return the base doc without its socketHost block, so a whole-document
// write clears every registered socketHost leaf.
function dropSocketHost<T extends { socketHost?: unknown }>(base: T): T {
  const { socketHost: _socketHost, ...rest } = base;
  return rest as T;
}
