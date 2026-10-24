import type { AppWindowMode } from './app-window-layout';

export type AppLaunchRequest = {
  urn: string;
  name: string;
  preferredUrl?: string;
  serverName?: string;
  logoUrl?: string;
  launchUrl?: string;
  manageUrl?: string;
  status?: string;
  recentKey?: string;
  categories?: string[];
};
export type AppWindow = {
  request: AppLaunchRequest;
  section: string;
  mode: AppWindowMode;
  status: 'visible' | 'minimizing' | 'minimized' | 'closing';
  automatic?: boolean;
};
type Workspace = { active?: string; ratio?: number; split?: { anchor: string; side: 'left' | 'right'; partner?: string } };
export type AppWindowState = { windows: AppWindow[]; section?: string; workspaces?: Record<string, Workspace> };
type Action =
  | { type: 'open'; request: AppLaunchRequest }
  | { type: 'focus' | 'minimize' | 'minimized' | 'close' | 'closed' | 'remove'; urn: string }
  | { type: 'place'; urn: string; mode: AppWindowMode }
  | { type: 'pair'; request: AppLaunchRequest }
  | { type: 'visit'; section: string }
  | { type: 'ratio'; value: number }
  | { type: 'hide' | 'dismiss-picker' };

export const appWorkspace = (state: AppWindowState): Workspace => state.workspaces?.[state.section ?? '/dashboard'] ?? {};

export function appWindowReducer(state: AppWindowState, action: Action): AppWindowState {
  const section = state.section ?? '/dashboard';
  const workspace = appWorkspace(state);
  const updateWorkspace = (next: Workspace) => ({ ...state.workspaces, [section]: next });
  const clearReference = (urn: string) =>
    Object.fromEntries(
      Object.entries(state.workspaces ?? {}).map(([key, value]) => [
        key,
        {
          ...value,
          active: value.active === urn ? undefined : value.active,
          split: value.split?.anchor === urn || value.split?.partner === urn ? undefined : value.split,
        },
      ]),
    );
  switch (action.type) {
    case 'open': {
      const existing = state.windows.find(({ request }) => request.urn === action.request.urn);
      const next: AppWindow = existing
        ? { ...existing, status: 'visible', automatic: false }
        : { request: action.request, section, status: 'visible', mode: 'floating' };
      return {
        ...state,
        workspaces: updateWorkspace({ ...workspace, active: action.request.urn }),
        windows: existing ? state.windows.map((item) => (item === existing ? next : item)) : [...state.windows, next],
      };
    }
    case 'visit': {
      if (state.section === action.section) return state;
      const windows = state.windows.map((item): AppWindow => {
        if (item.status === 'visible' && item.section !== action.section) return { ...item, status: 'minimizing', automatic: true };
        if (item.section === action.section && item.automatic && (item.status === 'minimized' || item.status === 'minimizing'))
          return { ...item, status: 'visible' };
        return item;
      });
      return { ...state, section: action.section, windows };
    }
    case 'ratio':
      return Number.isFinite(action.value)
        ? { ...state, workspaces: updateWorkspace({ ...workspace, ratio: Math.max(0.1, Math.min(0.9, action.value)) }) }
        : state;
    case 'focus':
      return workspace.active === action.urn ? state : { ...state, workspaces: updateWorkspace({ ...workspace, active: action.urn }) };
    case 'place': {
      const split = action.mode === 'left' || action.mode === 'right' ? { anchor: action.urn, side: action.mode } : undefined;
      return {
        ...state,
        workspaces: updateWorkspace({ active: action.urn, split, ratio: split ? 0.5 : workspace.ratio }),
        windows: state.windows.map((item) =>
          item.request.urn === action.urn ? { ...item, mode: action.mode, status: 'visible', automatic: false } : item,
        ),
      };
    }
    case 'pair': {
      const { split } = workspace;
      if (!split || split.anchor === action.request.urn) return state;
      const anchor = state.windows.find(({ request }) => request.urn === split.anchor);
      if (!anchor) return state;
      const existing = state.windows.find(({ request }) => request.urn === action.request.urn);
      const partner: AppWindow = {
        request: existing?.request ?? action.request,
        section: anchor.section,
        status: 'visible',
        mode: split.side === 'left' ? 'right' : 'left',
      };
      const windows = state.windows.map((item) => (item === existing ? partner : item));
      return {
        ...state,
        workspaces: updateWorkspace({ ...workspace, active: action.request.urn, split: { ...split, partner: action.request.urn } }),
        windows: existing ? windows : [...windows, partner],
      };
    }
    case 'hide':
      return {
        ...state,
        windows: state.windows.filter(({ status }) => status !== 'closing').map((item) => ({ ...item, status: 'minimized', automatic: false })),
      };
    case 'dismiss-picker':
      return { ...state, workspaces: updateWorkspace({ ...workspace, split: undefined }) };
    case 'closed':
      if (!state.windows.some((item) => item.request.urn === action.urn && item.status === 'closing')) return state;
      return { ...state, workspaces: clearReference(action.urn), windows: state.windows.filter(({ request }) => request.urn !== action.urn) };
    case 'remove':
      return { ...state, workspaces: clearReference(action.urn), windows: state.windows.filter(({ request }) => request.urn !== action.urn) };
    case 'minimized':
      return {
        ...state,
        windows: state.windows.map((item) =>
          item.request.urn === action.urn && item.status === 'minimizing' ? { ...item, status: 'minimized' } : item,
        ),
      };
    case 'minimize':
    case 'close':
      return {
        ...state,
        workspaces: clearReference(action.urn),
        windows: state.windows.map((item) =>
          item.request.urn === action.urn ? { ...item, status: action.type === 'minimize' ? 'minimizing' : 'closing', automatic: false } : item,
        ),
      };
  }
}
