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
type Split = { anchor: string; side: 'left' | 'right'; partner?: string };
type Workspace = { active?: string; ratio?: number; pickerDismissed?: boolean; split?: Split };
type ParkedSplit = { split: Split; ratio?: number };
export type AppWindowState = {
  windows: AppWindow[];
  section?: string;
  workspaces?: Record<string, Workspace>;
  parkedSplits?: ParkedSplit[];
};
type Action =
  | { type: 'reset-session' }
  | { type: 'open'; request: AppLaunchRequest; restorePair?: boolean }
  | { type: 'focus' | 'minimize' | 'minimized' | 'close' | 'closed' | 'remove'; urn: string }
  | { type: 'place'; urn: string; mode: AppWindowMode; partner?: string }
  | { type: 'pair'; request: AppLaunchRequest }
  | { type: 'remove-group'; urns: string[] }
  | { type: 'visit'; section: string }
  | { type: 'ratio'; value: number }
  | { type: 'hide' | 'dismiss-picker' };

export const appWorkspace = (state: AppWindowState): Workspace => state.workspaces?.[state.section ?? '/dashboard'] ?? {};

const minimized = ({ status }: AppWindow) => status === 'minimized' || status === 'minimizing';
const includesApp = (split: Split | undefined, urn: string) => split?.anchor === urn || split?.partner === urn;

export function parkedAppLayout(state: AppWindowState, urn: string) {
  return state.parkedSplits?.find(({ split }) => includesApp(split, urn));
}

export function appWindowRatio(state: AppWindowState, item: AppWindow) {
  return parkedAppLayout(state, item.request.urn)?.ratio ?? state.workspaces?.[item.section]?.ratio ?? 0.5;
}

export function minimizedAppGroups(state: AppWindowState): [AppWindow, ...AppWindow[]][] {
  const hidden = state.windows.filter(minimized);
  const grouped = new Set<string>();
  return hidden.flatMap((item) => {
    if (grouped.has(item.request.urn)) return [];
    const urn = item.request.urn;
    const split = parkedAppLayout(state, urn)?.split ?? state.workspaces?.[item.section]?.split;
    const pair = split?.partner && includesApp(split, urn) ? split : undefined;
    const partner = pair && hidden.find(({ request }) => request.urn !== urn && includesApp(pair, request.urn));
    const members: [AppWindow, ...AppWindow[]] = partner ? [item, partner] : [item];
    for (const member of members) grouped.add(member.request.urn);
    return [members];
  });
}

function clearWindowReference(state: AppWindowState, urn: string) {
  const workspaces = Object.fromEntries(
    Object.entries(state.workspaces ?? {}).map(([key, value]) => {
      let split = value.split;
      if (split && includesApp(split, urn)) {
        const survivor = split.anchor === urn ? split.partner : split.anchor;
        const visible = state.windows.some((item) => item.request.urn === survivor && item.status === 'visible');
        split =
          survivor && visible
            ? { anchor: survivor, side: split.anchor === urn ? (split.side === 'left' ? 'right' : 'left') : split.side }
            : undefined;
      }
      return [key, { ...value, active: value.active === urn ? split?.anchor : value.active, split }];
    }),
  );
  const parkedSplits = state.parkedSplits?.filter(({ split }) => !includesApp(split, urn));
  const splitModes = new Set(
    [...Object.values(workspaces), ...(parkedSplits ?? [])].flatMap(({ split }) => (split ? [split.anchor, split.partner] : [])),
  );
  const windows = state.windows.map((item) =>
    (item.mode === 'left' || item.mode === 'right') && !splitModes.has(item.request.urn) ? { ...item, mode: 'floating' as const } : item,
  );
  return { workspaces, parkedSplits, windows };
}

export function appWindowReducer(state: AppWindowState, action: Action): AppWindowState {
  const section = state.section ?? '/dashboard';
  const workspace = appWorkspace(state);
  const updateWorkspace = (next: Workspace) => ({ ...state.workspaces, [section]: next });
  switch (action.type) {
    case 'reset-session':
      return { windows: [], section: '/dashboard' };
    case 'open': {
      const urn = action.request.urn;
      const existing = state.windows.find(({ request }) => request.urn === urn);
      if (!existing)
        return {
          ...state,
          workspaces: updateWorkspace({ ...workspace, active: urn }),
          windows: [...state.windows, { request: action.request, section, status: 'visible', mode: 'floating' }],
        };

      if (action.restorePair === false)
        return appWindowReducer({ ...state, ...clearWindowReference(state, urn) }, { type: 'open', request: action.request });

      const source = state.workspaces?.[existing.section];
      const parked = parkedAppLayout(state, urn);
      const layout = parked ?? (includesApp(source?.split, urn) ? source : undefined);
      const split = layout?.split;
      const displace = split && workspace.split && workspace.split !== split ? workspace.split : undefined;
      const displacedPair = displace?.partner ? displace : undefined;
      const parkedSplits = (state.parkedSplits ?? []).filter((entry) => entry !== parked);
      // A section shows one split at a time. Keep its displaced pair available in the tray.
      if (displacedPair) parkedSplits.push({ split: displacedPair, ratio: workspace.ratio });
      const workspaces = updateWorkspace(split ? { ...layout, split, active: urn } : { ...workspace, active: urn });
      if (existing.section !== section && source) {
        workspaces[existing.section] = {
          ...source,
          split: source.split === split ? undefined : source.split,
          active: source.active === urn || (split && includesApp(split, source.active ?? '')) ? undefined : source.active,
        };
      }

      return {
        ...state,
        workspaces,
        parkedSplits,
        windows: state.windows.map((item) => {
          if (item === existing || (split && includesApp(split, item.request.urn) && minimized(item)))
            return { ...item, section, status: 'visible', automatic: false };
          if (includesApp(displacedPair, item.request.urn) && item.status !== 'closing')
            return { ...item, status: item.status === 'visible' ? 'minimizing' : item.status, automatic: false };
          if (displace && !displacedPair && item.request.urn === displace.anchor) return { ...item, mode: 'floating' };
          return item;
        }),
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
      const partner = state.windows.find(
        (item) => item.request.urn === action.partner && item.request.urn !== action.urn && item.section === section && item.status === 'visible',
      );
      const split =
        action.mode === 'left' || action.mode === 'right'
          ? { anchor: action.urn, side: action.mode, ...(partner ? { partner: partner.request.urn } : {}) }
          : undefined;
      const replacesSplit = Boolean(split) || includesApp(workspace.split, action.urn);
      const cleared = clearWindowReference(state, action.urn);
      return {
        ...state,
        ...cleared,
        workspaces: {
          ...cleared.workspaces,
          [section]: replacesSplit
            ? { active: action.urn, split, pickerDismissed: false, ratio: split ? 0.5 : workspace.ratio }
            : { ...workspace, active: action.urn },
        },
        windows: cleared.windows.map((item) =>
          item.request.urn === action.urn
            ? { ...item, mode: action.mode, status: 'visible', automatic: false }
            : split && item.request.urn === partner?.request.urn
              ? { ...item, mode: split.side === 'left' ? 'right' : 'left' }
              : replacesSplit && includesApp(workspace.split, item.request.urn)
                ? { ...item, mode: 'floating' }
                : item,
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
      const cleared = clearWindowReference(state, action.request.urn);
      const windows = cleared.windows.map((item) => (item.request.urn === action.request.urn ? partner : item));
      return {
        ...state,
        ...cleared,
        workspaces: {
          ...cleared.workspaces,
          [section]: { ...workspace, active: action.request.urn, pickerDismissed: false, split: { ...split, partner: action.request.urn } },
        },
        windows: existing ? windows : [...windows, partner],
      };
    }
    case 'hide': {
      const closing = state.windows.filter(({ status }) => status === 'closing').map(({ request }) => request.urn);
      const kept = appWindowReducer(state, { type: 'remove-group', urns: closing });
      return { ...kept, windows: kept.windows.map((item) => ({ ...item, status: 'minimized', automatic: false })) };
    }
    case 'dismiss-picker':
      return { ...state, workspaces: updateWorkspace({ ...workspace, pickerDismissed: true }) };
    case 'remove-group':
      return action.urns.reduce((next, urn) => appWindowReducer(next, { type: 'remove', urn }), state);
    case 'closed':
    case 'remove': {
      if (action.type === 'closed' && !state.windows.some((item) => item.request.urn === action.urn && item.status === 'closing')) return state;
      const cleared = clearWindowReference(state, action.urn);
      return { ...state, ...cleared, windows: cleared.windows.filter(({ request }) => request.urn !== action.urn) };
    }
    case 'minimized':
      return {
        ...state,
        windows: state.windows.map((item) =>
          item.request.urn === action.urn && item.status === 'minimizing' ? { ...item, status: 'minimized' } : item,
        ),
      };
    case 'minimize': {
      const split = workspace.split;
      const group = split?.partner && includesApp(split, action.urn) ? split : undefined;
      return {
        ...state,
        windows: state.windows.map((item) =>
          item.status === 'visible' && (item.request.urn === action.urn || includesApp(group, item.request.urn))
            ? { ...item, status: 'minimizing', automatic: false }
            : item,
        ),
      };
    }
    case 'close':
      return {
        ...state,
        windows: state.windows.map((item) => (item.request.urn === action.urn ? { ...item, status: 'closing', automatic: false } : item)),
      };
  }
}
