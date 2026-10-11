// The window's accessibility tree (the DevTools protocol's
// Accessibility.getFullAXTree) as the outline `look` answers: one line
// per thing a person sees or uses, indented under what holds it, each
// control with the ref the other actions take.
//
//   - heading "Settings" [ref=41] level=1
//     - button "Save" [ref=57] disabled

type AxValue = { readonly value?: unknown };
type AxNode = {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly properties?: ReadonlyArray<{
    readonly name: string;
    readonly value: AxValue;
  }>;
  readonly childIds?: ReadonlyArray<string>;
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
};

// Roles that only hold others: their children stand in their place.
const HOLDERS = new Set(["generic", "none", "presentation", "LineBreak"]);
const TEXT = new Set(["StaticText", "InlineTextBox"]);
const STATES = new Set([
  "focused",
  "disabled",
  "checked",
  "pressed",
  "selected",
  "expanded",
  "level",
]);

// Past this many lines the outline is cut: a page that long is better
// read a part at a time, after a scroll or a click.
const MAX_LINES = 1500;

const text = (value: AxValue | undefined) =>
  typeof value?.value === "string" || typeof value?.value === "number"
    ? String(value.value).trim()
    : "";

const quoted = (value: string) =>
  JSON.stringify(value.length > 120 ? `${value.slice(0, 119)}…` : value);

export function axOutline(answer: unknown): string {
  const nodes =
    (answer as { nodes?: ReadonlyArray<AxNode> } | undefined)?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find(
    (node) => node.parentId === undefined || !byId.has(node.parentId),
  );
  const lines: string[] = [];

  // `heldBy` is the name of the nearest shown node above: text that only
  // repeats it (a button's label) is left out.
  const walk = (node: AxNode, depth: number, heldBy: string) => {
    if (lines.length > MAX_LINES) return;
    const role = text(node.role);
    const name = text(node.name);
    const children = (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child === undefined ? [] : [child];
    });
    const shows =
      node.ignored !== true &&
      role !== "" &&
      role !== "RootWebArea" &&
      !HOLDERS.has(role) &&
      !(TEXT.has(role) && (name === "" || heldBy.includes(name)));
    if (shows) {
      if (role === "InlineTextBox") return;
      if (role === "StaticText") {
        lines.push(`${"  ".repeat(depth)}- text ${quoted(name)}`);
        return;
      }
      const parts = [`${"  ".repeat(depth)}- ${role}`];
      if (name !== "") parts.push(quoted(name));
      if (node.backendDOMNodeId !== undefined) {
        parts.push(`[ref=${node.backendDOMNodeId}]`);
      }
      const value = text(node.value);
      if (value !== "") parts.push(`value=${quoted(value)}`);
      for (const property of node.properties ?? []) {
        if (!STATES.has(property.name)) continue;
        const state = property.value.value;
        if (state === false || state === "false") continue;
        parts.push(
          state === true || state === "true"
            ? property.name
            : `${property.name}=${String(state)}`,
        );
      }
      lines.push(parts.join(" "));
    }
    for (const child of children) {
      walk(child, shows ? depth + 1 : depth, shows ? name : heldBy);
    }
  };

  if (root !== undefined) walk(root, 0, "");
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines.push("… (cut: scroll or open a part of the page, then look again)");
  }
  return lines.join("\n");
}
