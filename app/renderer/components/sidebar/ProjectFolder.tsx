// The folders on the list of projects (useProjectFolders): a folder's
// header, with its rename and ungroup, a project's pick of folder, a
// project dragged into one (on the forest and the home page's grid),
// and the dialog naming a folder, which the shell mounts
// (FolderNameDialog) so it outlasts the row it was asked for from.
import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useCombinedRefs } from "@dnd-kit/utilities";
import type { Project } from "@shigomori/contracts/schemas";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import type { SidebarRow } from "@shigomori/ui/views/sidebar/sidebarRow.ts";
import {
  FolderNameDialogView,
  ProjectFolderHeaderView,
  ProjectFolderSubmenuView,
} from "@shigomori/ui/views/sidebar/ProjectFolderView.tsx";
import { ProjectDragPreviewView } from "@shigomori/ui/views/sidebar/ProjectDragPreviewView.tsx";
import { useSetProjectFolder } from "@/hooks/sharedSettings/useProjectFolders";
import { usePhoneLayout } from "@/hooks/ui/useViewport";

// The projects being named a folder for, and the folder's name when
// it is a rename (null: a new one).
const namingAtom = Atom.keepAlive(
  Atom.make<{ groupKeys: readonly string[]; name: string | null } | null>(null),
);

// A project dragged on the list, and what it can be dropped on. Each
// is in a section (an owner's, or the whole list's), which a folder
// is kept within.
interface FolderDragItem {
  section: string;
  groupKey: string;
  folder: string | null;
}

type FolderDropTarget =
  | { kind: "folder"; section: string; name: string }
  | (FolderDragItem & { kind: "project" });

type FolderDrop = { folder: string | null } | { newFolderWith: string };

// Onto a folder, or a project in one, files it there. Onto a project in
// none takes it out of its folder, or, out of one already, starts a new
// folder with both. Null where the drop changes nothing, and across
// sections.
function folderDrop(
  item: FolderDragItem,
  target: FolderDropTarget,
): FolderDrop | null {
  if (target.section !== item.section) return null;
  const into = target.kind === "folder" ? target.name : target.folder;
  if (into !== null) return into === item.folder ? null : { folder: into };
  if (target.kind === "folder" || target.groupKey === item.groupKey)
    return null;
  return item.folder === null
    ? { newFolderWith: target.groupKey }
    : { folder: null };
}

// The drag into folders: its DndContext's sensors and handlers, and
// the preview it draws. The forest's context shares the sensors with
// arranging.
export function useFolderDragging() {
  const [dragged, setDragged] = useState<Project | null>(null);
  const setFolder = useSetProjectFolder();
  const setNaming = useAtomSet(namingAtom);
  // A quick click still opens what it lands on.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const handlers = {
    collisionDetection: pointerWithin,
    onDragStart: ({ active }: DragStartEvent) =>
      setDragged(active.data.current?.project ?? null),
    onDragEnd: ({ active, over }: DragEndEvent) => {
      setDragged(null);
      const item: FolderDragItem | undefined = active.data.current?.folderItem;
      const target = over?.data.current as FolderDropTarget | undefined;
      const drop = item && target && folderDrop(item, target);
      if (!item || !drop) return;
      if ("folder" in drop) setFolder([item.groupKey], drop.folder);
      else
        setNaming({
          groupKeys: [drop.newFolderWith, item.groupKey],
          name: null,
        });
    },
    onDragCancel: () => setDragged(null),
  };
  const overlay = (
    // No flight back on drop: the project lands where it was dropped.
    <DragOverlay modifiers={[trailPointer]} dropAnimation={null}>
      {dragged && <ProjectDragPreviewView project={dragged} chip />}
    </DragOverlay>
  );
  return { sensors, handlers, overlay };
}

// The drag into folders on a page with no drag of its own (the home
// page's grid).
export function FolderDragContext({ children }: { children: ReactNode }) {
  const { sensors, handlers, overlay } = useFolderDragging();
  return (
    <DndContext sensors={sensors} {...handlers}>
      {children}
      {overlay}
    </DndContext>
  );
}

// The preview trails the pointer, below and to the right of it,
// leaving what is under it to show where the project lands.
const trailPointer: Modifier = ({
  transform,
  activatorEvent,
  draggingNodeRect,
}) => {
  if (!(activatorEvent instanceof PointerEvent) || draggingNodeRect === null)
    return transform;
  return {
    ...transform,
    x: transform.x + activatorEvent.clientX - draggingNodeRect.left + 12,
    y: transform.y + activatorEvent.clientY - draggingNodeRect.top + 12,
  };
};

// A project's row or tile, dragged into a folder and dropped on. Not a
// missing one, and not on a phone, where the drag would fight the
// scroll.
export function useFolderDrag({
  id,
  project,
  item,
  disabled,
  droppable = true,
}: {
  // The row's group id.
  id: string;
  project: Project;
  item: FolderDragItem;
  disabled: boolean;
  droppable?: boolean;
}) {
  const phone = usePhoneLayout();
  const enabled = !disabled && project.pathExists !== false && !phone;
  const drag = useDraggable({
    id: `file:${id}`,
    data: { project, folderItem: item },
    disabled: !enabled,
  });
  const drop = useFolderDropTarget(
    `file:${id}`,
    { kind: "project", ...item },
    !enabled || !droppable,
  );
  return {
    setNodeRef: useCombinedRefs(drag.setNodeRef, drop.setNodeRef),
    listeners: drag.listeners,
    isDragging: drag.isDragging,
    dropping: drop.dropping,
  };
}

// The drop target a row is, and whether the project dragged over it
// would land.
export function useFolderDropTarget(
  id: string,
  target: FolderDropTarget,
  disabled = false,
) {
  const { setNodeRef, isOver, active } = useDroppable({
    id,
    data: target,
    disabled,
  });
  const item: FolderDragItem | undefined = active?.data.current?.folderItem;
  const dropping = isOver && !!item && folderDrop(item, target) !== null;
  return { setNodeRef, dropping };
}

export function ProjectFolderHeader({
  row,
  onToggle,
}: {
  row: Extract<SidebarRow, { kind: "project-folder" }>;
  onToggle: () => void;
}) {
  const setFolder = useSetProjectFolder();
  const setNaming = useAtomSet(namingAtom);
  const drop = useFolderDropTarget(`folder:${row.foldKey}`, {
    kind: "folder",
    section: row.section,
    name: row.name,
  });
  return (
    <ProjectFolderHeaderView
      dropRef={drop.setNodeRef}
      dropping={drop.dropping}
      name={row.name}
      count={row.count}
      expanded={row.expanded}
      onToggle={onToggle}
      onRename={() => setNaming({ groupKeys: row.groupKeys, name: row.name })}
      onUngroup={() => setFolder(row.groupKeys, null)}
    />
  );
}

export function ProjectFolderSubmenu({
  groupKey,
  folder,
  folders,
}: {
  groupKey: string;
  folder: string | null;
  folders: readonly string[];
}) {
  const setFolder = useSetProjectFolder();
  const setNaming = useAtomSet(namingAtom);
  return (
    <ProjectFolderSubmenuView
      folder={folder}
      folders={folders}
      onPick={(name) => setFolder([groupKey], name)}
      onNewFolder={() => setNaming({ groupKeys: [groupKey], name: null })}
    />
  );
}

export function FolderNameDialog() {
  const naming = useAtomValue(namingAtom);
  const setNaming = useAtomSet(namingAtom);
  if (naming === null) return null;
  return (
    <FolderNameDialogShell
      groupKeys={naming.groupKeys}
      initial={naming.name}
      onClose={() => setNaming(null)}
    />
  );
}

function FolderNameDialogShell({
  groupKeys,
  initial,
  onClose,
}: {
  groupKeys: readonly string[];
  initial: string | null;
  onClose: () => void;
}) {
  const setFolder = useSetProjectFolder();
  const [name, setName] = useState(initial ?? "");
  const title = initial === null ? "New folder" : "Rename folder";
  return (
    <ModalShell label={title} onClose={onClose} popoverClassName="max-w-sm">
      <FolderNameDialogView
        title={title}
        verb={initial === null ? "Create" : "Rename"}
        name={name}
        onNameChange={setName}
        onSave={() => {
          setFolder(groupKeys, name.trim());
          onClose();
        }}
        onCancel={onClose}
      />
    </ModalShell>
  );
}
