import type {
  Database,
  Delta,
  DateRange,
  Member,
  SnapshotMeta,
  Settings,
  Sprint,
  SprintCapacity,
  WorkItem,
  WorkItemLink,
  Comment,
  Hyperlink,
} from '../../shared/types';
import type { LinkType, WorkItemType } from '../../shared/process';
import type { AuthAdminView, AuthSettings, AuthStatus, LoginResult } from '../../shared/auth';
import { applyDelta, setDatabase, toast, useStore } from './store';

const clientId = crypto.randomUUID();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** True for the error the server returns when sign-in is on and the session is missing or has ended. */
export const isSignInError = (err: unknown) => err instanceof ApiError && err.status === 401 && err.code === 'signin';

/** The session ended (timed out, signed out elsewhere, or sign-in was turned on): show the sign-in screen. */
export function requireSignIn() {
  source?.close();
  source = null;
  useStore.setState({ signInRequired: true, connection: 'connecting' });
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Client-Id': clientId };
  const user = useStore.getState().currentUserId;
  if (user) headers['X-User'] = encodeURIComponent(user);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
    if (isSignInError(err)) requireSignIn();
    throw err;
  }
  return data as T;
}

/** Perform a mutation, apply the returned delta locally, and surface errors as toasts. */
async function mutate<T = unknown>(method: string, url: string, body?: unknown, opts: { quiet?: boolean } = {}): Promise<T> {
  try {
    const { delta, result } = await request<{ delta: Delta; result: T }>(method, url, body);
    if (applyDelta(delta)) await loadAll();
    return result;
  } catch (err) {
    if (!opts.quiet && !isSignInError(err)) toast(err instanceof Error ? err.message : 'Something went wrong', 'error');
    throw err;
  }
}

export async function loadAll() {
  const { db } = await request<{ db: Database }>('GET', '/bootstrap');
  setDatabase(db);
}

let source: EventSource | null = null;
export function connectEvents() {
  source?.close();
  useStore.setState({ connection: 'connecting' });
  source = new EventSource('/api/events');
  source.addEventListener('hello', (e) => {
    useStore.setState({ connection: 'live' });
    const { version } = JSON.parse((e as MessageEvent).data) as { version: number };
    // We may have missed changes while disconnected.
    if (version !== useStore.getState().version) void loadAll();
  });
  source.onmessage = (e) => {
    const { delta } = JSON.parse(e.data) as { delta: Delta; origin?: string };
    if (applyDelta(delta)) void loadAll();
  };
  source.onerror = () => {
    useStore.setState({ connection: 'offline' });
    void checkSession();
  };
}

// The live-updates stream drops when a session ends. Ask the server (at most every 10s)
// whether we're still signed in, rather than letting the browser retry forever.
let lastCheck = 0;
async function checkSession() {
  if (Date.now() - lastCheck < 10_000) return;
  lastCheck = Date.now();
  try {
    const status = await request<AuthStatus>('GET', '/auth/status');
    useStore.setState({ auth: status });
    if (status.enabled && !status.user) requireSignIn();
  } catch {
    // Server unreachable: stay "offline" and let EventSource keep retrying.
  }
}

export type WorkItemFields = Partial<Omit<WorkItem, 'id' | 'type' | 'comments' | 'history' | 'hyperlinks' | 'createdAt' | 'createdBy' | 'changedAt' | 'changedBy' | 'closedAt' | 'stackRank' | 'reason'>>;

export interface MoveInput {
  afterId?: number | null;
  beforeId?: number | null;
  iterationId?: string | null;
  parentId?: number | null;
  state?: string;
  assignedTo?: string | null;
}

export const api = {
  createWorkItem: (type: WorkItemType, fields: WorkItemFields & { title: string; position?: 'top' | 'bottom' }) =>
    mutate<WorkItem>('POST', '/workitems', { type, ...fields }),
  updateWorkItem: (id: number, fields: WorkItemFields) => mutate<WorkItem>('PATCH', `/workitems/${id}`, fields),
  deleteWorkItem: (id: number) => mutate('DELETE', `/workitems/${id}`),
  deleteWorkItems: (ids: number[]) => mutate('POST', '/workitems/bulk-delete', { ids }),
  moveWorkItem: (id: number, input: MoveInput) => mutate<WorkItem>('POST', `/workitems/${id}/move`, input),
  copyWorkItem: (id: number, includeChildren: boolean) => mutate<WorkItem>('POST', `/workitems/${id}/copy`, { includeChildren }),
  bulkUpdate: (ids: number[], changes: WorkItemFields, tags?: { addTags?: string[]; removeTags?: string[] }) =>
    mutate('POST', '/workitems/bulk', { ids, changes, ...tags }),
  addComment: (id: number, text: string) => mutate<Comment>('POST', `/workitems/${id}/comments`, { text }),
  editComment: (id: number, commentId: string, text: string) => mutate<Comment>('PATCH', `/workitems/${id}/comments/${commentId}`, { text }),
  deleteComment: (id: number, commentId: string) => mutate('DELETE', `/workitems/${id}/comments/${commentId}`),
  addHyperlink: (id: number, url: string, comment: string) => mutate<Hyperlink>('POST', `/workitems/${id}/hyperlinks`, { url, comment }),
  removeHyperlink: (id: number, linkId: string) => mutate('DELETE', `/workitems/${id}/hyperlinks/${linkId}`),
  addLink: (sourceId: number, targetId: number, type: LinkType, comment = '') =>
    mutate<WorkItemLink>('POST', '/links', { sourceId, targetId, type, comment }),
  removeLink: (id: string) => mutate('DELETE', `/links/${id}`),
  restoreDeleted: (id: number) => mutate<WorkItem>('POST', `/recycle-bin/${id}/restore`),
  purgeDeleted: (id: number) => mutate('DELETE', `/recycle-bin/${id}`),

  createSprint: (input: Partial<Omit<Sprint, 'id'>> & { name: string }) => mutate<Sprint>('POST', '/sprints', input),
  updateSprint: (id: string, input: Partial<Omit<Sprint, 'id'>>) => mutate<Sprint>('PATCH', `/sprints/${id}`, input),
  deleteSprint: (id: string, moveTo: string | null) => mutate('DELETE', `/sprints/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`),
  setCapacity: (sprintId: string, capacity: { teamDaysOff: DateRange[]; members: SprintCapacity['members'] }) =>
    mutate<SprintCapacity>('PUT', `/sprints/${sprintId}/capacity`, capacity),
  copyCapacity: (sprintId: string, fromSprintId: string) => mutate<SprintCapacity>('POST', `/sprints/${sprintId}/capacity/copy`, { fromSprintId }),

  createMember: (input: Partial<Omit<Member, 'id'>> & { name: string }) => mutate<Member>('POST', '/members', input),
  updateMember: (id: string, input: Partial<Omit<Member, 'id'>>) => mutate<Member>('PATCH', `/members/${id}`, input),
  deleteMember: (id: string) => mutate('DELETE', `/members/${id}`),
  updateSettings: (input: Partial<Settings>) => mutate<Settings>('PATCH', '/settings', input),

  listSnapshots: () => request<SnapshotMeta[]>('GET', '/snapshots'),
  createSnapshot: (name: string, description: string) => request<SnapshotMeta>('POST', '/snapshots', { name, description }),
  updateSnapshot: (id: string, changes: { name?: string; description?: string }) => request<SnapshotMeta>('PATCH', `/snapshots/${id}`, changes),
  deleteSnapshot: (id: string) => request<void>('DELETE', `/snapshots/${id}`),
  restoreSnapshot: async (id: string) => {
    const r = await request<{ safetySnapshot: SnapshotMeta }>('POST', `/snapshots/${id}/restore`);
    await loadAll();
    return r;
  },
  importBackup: async (data: unknown) => {
    const r = await request<{ safetySnapshot: SnapshotMeta }>('POST', '/backup/import', data);
    await loadAll();
    return r;
  },
  resetData: async (mode: 'empty' | 'demo') => {
    const r = await request<{ safetySnapshot: SnapshotMeta }>('POST', '/backup/reset', { mode });
    await loadAll();
    return r;
  },
};

/** Sign-in endpoints. Errors are returned to the caller rather than shown as toasts. */
export const authApi = {
  status: () => request<AuthStatus>('GET', '/auth/status'),
  login: (username: string, password: string) => request<LoginResult>('POST', '/auth/login', { username, password }),
  /** First-time setup (no currentPassword), expired/temporary passwords, or a voluntary change. */
  setPassword: (input: { username: string; currentPassword?: string; newPassword: string }) => request<LoginResult>('POST', '/auth/password', input),
  logout: () => request<void>('POST', '/auth/logout'),
  admin: () => request<AuthAdminView>('GET', '/auth/admin'),
  updateSettings: (patch: Partial<AuthSettings>) => request<AuthAdminView>('PUT', '/auth/settings', patch),
  setAdmin: (memberId: string, isAdmin: boolean) => request<AuthAdminView>('PATCH', `/auth/accounts/${memberId}`, { isAdmin }),
  setPasswordFor: (memberId: string, password: string, mustChange: boolean) => request<AuthAdminView>('POST', `/auth/accounts/${memberId}/password`, { password, mustChange }),
  resetPassword: (memberId: string) => request<AuthAdminView>('POST', `/auth/accounts/${memberId}/reset`),
};

/** Start the app: find out whether sign-in is needed, then load data and connect live updates. */
export async function startApp() {
  const status = await authApi.status();
  useStore.setState({ auth: status, signInRequired: status.enabled && !status.user });
  if (status.enabled && !status.user) return;
  await loadAll();
  connectEvents();
}

export async function signOut() {
  try {
    await authApi.logout();
  } finally {
    useStore.setState((s) => ({ auth: s.auth ? { ...s.auth, user: null } : s.auth }));
    requireSignIn();
  }
}
