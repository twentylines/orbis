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
  mode: AppWindowMode;
  status: 'visible' | 'minimizing' | 'minimized' | 'closing';
};
export type AppWindowState = { windows: AppWindow[]; active?: string; split?: { anchor: string; side: 'left' | 'right'; partner?: string } };
type Action =
  | { type: 'open'; request: AppLaunchRequest }
  | { type: 'focus' | 'minimize' | 'minimized' | 'close' | 'remove'; urn: string }
  | { type: 'place'; urn: string; mode: AppWindowMode }
  | { type: 'pair'; request: AppLaunchRequest }
  | { type: 'hide' | 'dismiss-picker' };

export function appWindowReducer(state: AppWindowState, action: Action): AppWindowState {
  const minimize = (item: AppWindow): AppWindow => (item.status === 'closing' ? item : { ...item, status: 'minimized' });
  switch (action.type) {
    case 'open': {
      const existing = state.windows.find(({ request }) => request.urn === action.request.urn);
      if (existing?.status === 'visible') return { ...state, active: action.request.urn };
      const next: AppWindow = { request: existing?.request ?? action.request, status: 'visible', mode: 'floating' };
      return {
        active: action.request.urn,
        windows: existing ? state.windows.map((item) => (item === existing ? next : minimize(item))) : [...state.windows.map(minimize), next],
      };
    }
    case 'focus':
      return state.active === action.urn ? state : { ...state, active: action.urn };
    case 'place': {
      const split = action.mode === 'left' || action.mode === 'right' ? { anchor: action.urn, side: action.mode } : undefined;
      return {
        active: action.urn,
        split,
        windows: state.windows.map((item) => (item.request.urn === action.urn ? { ...item, mode: action.mode, status: 'visible' } : minimize(item))),
      };
    }
    case 'pair': {
      const { split } = state;
      if (!split || split.anchor === action.request.urn) return state;
      const existing = state.windows.find(({ request }) => request.urn === action.request.urn);
      const partner: AppWindow = { request: existing?.request ?? action.request, status: 'visible', mode: split.side === 'left' ? 'right' : 'left' };
      const windows = state.windows.map((item) => (item.request.urn === split.anchor ? item : item === existing ? partner : minimize(item)));
      return { active: action.request.urn, split: { ...split, partner: action.request.urn }, windows: existing ? windows : [...windows, partner] };
    }
    case 'hide':
      return { windows: state.windows.filter(({ status }) => status !== 'closing').map(minimize) };
    case 'dismiss-picker':
      return { ...state, split: undefined };
    case 'remove':
      return {
        ...state,
        active: state.active === action.urn ? undefined : state.active,
        split: state.split?.anchor === action.urn || state.split?.partner === action.urn ? undefined : state.split,
        windows: state.windows.filter(({ request }) => request.urn !== action.urn),
      };
    case 'minimize':
    case 'minimized':
    case 'close':
      return {
        ...state,
        active: state.active === action.urn ? undefined : state.active,
        split: state.split?.anchor === action.urn || state.split?.partner === action.urn ? undefined : state.split,
        windows: state.windows.map((item) =>
          item.request.urn === action.urn
            ? { ...item, status: action.type === 'minimize' ? 'minimizing' : action.type === 'close' ? 'closing' : 'minimized' }
            : item,
        ),
      };
  }
}
