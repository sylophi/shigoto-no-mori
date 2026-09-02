import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from "react";

// One footer, many forms. The Settings page keeps every device's form
// mounted once visited (so switching tabs never drops an edit), and the
// footer's Save and Discard act on all of them at once. Each device
// form reports itself here. The page reads the flags to render the
// footer, and calls the functions
// from its Save and Discard.
export interface SettingsEditor {
  isDirty: boolean;
  isPending: boolean;
  isSuccess: boolean;
  // Never rejects: an editor surfaces its own failure (the mutation's
  // toast and its panel's banner) and stays dirty for a retry.
  save: () => Promise<void>;
  discard: () => void;
}

// What the footer needs from all the editors at once.
export interface EditorSummary {
  isDirty: boolean;
  isPending: boolean;
  isSuccess: boolean;
}

interface EditorRegistry {
  register(id: string, editor: SettingsEditor): void;
  unregister(id: string): void;
}

const EditorRegistryContext = createContext<EditorRegistry | null>(null);

function summarize(editors: Iterable<SettingsEditor>): EditorSummary {
  const summary = { isDirty: false, isPending: false, isSuccess: false };
  for (const editor of editors) {
    summary.isDirty ||= editor.isDirty;
    summary.isPending ||= editor.isPending;
    summary.isSuccess ||= editor.isSuccess;
  }
  return summary;
}

function sameSummary(a: EditorSummary, b: EditorSummary): boolean {
  return (
    a.isDirty === b.isDirty &&
    a.isPending === b.isPending &&
    a.isSuccess === b.isSuccess
  );
}

// The page-side half. Editors re-register on every render (their save
// and discard close over fresh form state), which lands in a ref. Only
// a change in the summary re-renders the page, so a registration
// cannot loop the render it came from.
export function useSettingsEditorRegistry() {
  const latest = useRef(new Map<string, SettingsEditor>());
  const [summary, setSummary] = useState<EditorSummary>(() => summarize([]));
  const [registry] = useState<EditorRegistry>(() => {
    const publish = () => {
      const next = summarize(latest.current.values());
      setSummary((prev) => (sameSummary(prev, next) ? prev : next));
    };
    return {
      register(id, editor) {
        latest.current.set(id, editor);
        publish();
      },
      unregister(id) {
        latest.current.delete(id);
        publish();
      },
    };
  });

  // In parallel: each save is a round trip to a different machine, and
  // every editor settles its own outcome (a refused patch stays dirty
  // in its panel), so one slow or refusing peer never holds the rest.
  const saveAll = async () => {
    const dirty = [...latest.current.values()].filter((e) => e.isDirty);
    await Promise.all(dirty.map((editor) => editor.save()));
  };
  const discardAll = () => {
    for (const editor of latest.current.values()) editor.discard();
  };

  return { registry, summary, saveAll, discardAll };
}

export function SettingsEditorRegistryProvider({
  registry,
  children,
}: {
  registry: EditorRegistry;
  children: ReactNode;
}) {
  return (
    <EditorRegistryContext value={registry}>{children}</EditorRegistryContext>
  );
}

// The editor-side half. No dependency array on the first effect on
// purpose: the editor object is rebuilt every render and the registry
// wants the latest closures. The registry's own summary comparison keeps
// that from re-rendering anything.
export function useRegisterSettingsEditor(
  id: string,
  editor: SettingsEditor,
): void {
  const registry = use(EditorRegistryContext);
  if (registry === null) {
    throw new Error(
      "useRegisterSettingsEditor must run inside SettingsEditorRegistryProvider",
    );
  }
  useEffect(() => {
    registry.register(id, editor);
  });
  useEffect(() => () => registry.unregister(id), [registry, id]);
}
