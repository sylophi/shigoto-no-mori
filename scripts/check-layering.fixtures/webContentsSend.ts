// Fixture: a direct `webContents.send(...)` outside main/ipc/register.ts.
// Triggers `webcontents-send`.
interface FakeWebContents {
  send(channel: string, payload: unknown): void;
}

export function blast(webContents: FakeWebContents): void {
  webContents.send("channel:test", { hello: "world" });
}
