import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useDesktopPreferences } from './preferences';
import { toolbarActionIds, workspaceEditingEvent, type ToolbarActionId } from './workspace-layout';
import { useWorkspaceSortable } from './workspace-sortable';
import './system-toolbar.css';

export function SystemToolbar({ actions, children }: { actions: Record<ToolbarActionId, ReactNode>; children?: ReactNode }) {
  const { preferences, update, workspaceCapabilities } = useDesktopPreferences();
  const [editing, setEditing] = useState(false);
  useLayoutEffect(() => {
    const receive = (event: Event) => setEditing(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(workspaceEditingEvent, receive);
    return () => window.removeEventListener(workspaceEditingEvent, receive);
  }, []);
  const enabled = editing && Boolean(workspaceCapabilities?.toolbarOrder);
  const sortable = useWorkspaceSortable(
    preferences.toolbarOrder ?? [...toolbarActionIds],
    (toolbarOrder) => update({ toolbarOrder }),
    enabled,
    'insert',
    16,
  );
  return (
    <div className="desktop-system-actions" data-toolbar-editing={enabled || undefined}>
      {children}
      {sortable.order.map((id) => (
        <div className="desktop-toolbar-action" data-action={id} key={id} {...sortable.itemProps(id)}>
          {enabled ? (
            <button
              className="desktop-toolbar-grip"
              type="button"
              {...sortable.gripProps(id, `${id === 'connection' ? 'server address' : id} action`)}
            />
          ) : null}
          <div className="desktop-toolbar-content" inert={enabled || undefined}>
            {actions[id]}
          </div>
        </div>
      ))}
      {editing ? (
        <output className="visually-hidden" aria-live="polite">
          {sortable.announcement}
        </output>
      ) : null}
    </div>
  );
}
