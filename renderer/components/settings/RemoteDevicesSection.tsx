import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";
import { DeviceStatusDot } from "@/components/remote/DeviceStatusDot";
import { useLocalGlobalConfigUpdate } from "@/hooks/config/useLocalGlobalConfigUpdate";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { deviceVersionMismatch } from "@/lib/remote/devices";

// "Remote devices": the machines this client connects OUT to. The live
// list, status and connection come from the registry (useRemoteDevices);
// the tokens live only in the local config, so add and remove
// read-modify-write the unredacted doc and re-reconcile the registry.
export function RemoteDevicesSection() {
  // Only the url-keyed LAN entries belong here. Relay devices live in
  // the store too but are managed through the Account section.
  const devices = useRemoteDevices().filter((device) => device.kind === "lan");
  const navigate = useNavigate();
  const update = useLocalGlobalConfigUpdate("Couldn't update remote devices");

  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const busy = update.isPending;

  const canAdd = url.trim().length > 0 && token.trim().length > 0 && !busy;

  const add = () => {
    const entry = {
      label: label.trim() === "" ? undefined : label.trim(),
      url: url.trim(),
      token: token.trim(),
    };
    update.mutate(
      (base) => ({
        ...base,
        remoteDevices: [...(base.remoteDevices ?? []), entry],
      }),
      {
        onSuccess: () => {
          setLabel("");
          setUrl("");
          setToken("");
        },
      },
    );
  };

  const remove = (targetUrl: string) => {
    update.mutate((base) => ({
      ...base,
      remoteDevices: (base.remoteDevices ?? []).filter(
        (d) => d.url !== targetUrl,
      ),
    }));
  };

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Remote devices</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Other machines to browse read only. Enter the host&apos;s{" "}
          <span className="font-mono">ws://</span> address and the token it
          shows under its own hosting settings.
        </p>
      </div>

      {devices.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          None yet. Add one below to connect.
        </p>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => {
            const { connected } = deviceStatusView(device.status);
            return (
              <div
                key={device.url}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{device.label}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {device.url}
                  </span>
                </div>
                <DeviceStatusDot status={device.status} />
                {deviceVersionMismatch(device) && (
                  <span className="text-xs text-amber-500">
                    Update the other machine
                  </span>
                )}
                {connected && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void navigate({
                        to: "/devices/$deviceId",
                        params: { deviceId: device.deviceId },
                      })
                    }
                  >
                    View forest
                    <ArrowRight />
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => remove(device.url)}
                  disabled={busy}
                  aria-label={`Remove ${device.label}`}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <X className="size-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-[minmax(5rem,8rem)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
        <Input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          aria-label="Device label"
          className="min-w-0 px-2.5 py-1.5 text-sm"
        />
        <Input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://host:42017"
          aria-label="Device url"
          className="min-w-0 px-2.5 py-1.5 font-mono text-xs"
        />
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token"
          aria-label="Device token"
          className="min-w-0 px-2.5 py-1.5 font-mono text-xs"
        />
        <Button variant="outline" size="sm" disabled={!canAdd} onClick={add}>
          <Plus />
          Add
        </Button>
      </div>
    </section>
  );
}
