import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { signOut, startApp } from './api';
import { ConfirmHost, Toasts, useMenu } from './components/common';
import { ChangePasswordDialog, SignInScreen } from './components/SignIn';
import { Icon } from './components/Icon';
import { WorkItemDialogHost, useWorkItemDialog } from './components/WorkItemForm';
import { BacklogPage } from './pages/BacklogPage';
import { BoardPage } from './pages/BoardPage';
import { SettingsPage } from './pages/SettingsPage';
import { SprintPage } from './pages/SprintPage';
import { WorkItemsPage } from './pages/WorkItemsPage';
import { setCurrentUser, useStore } from './store';
import { Avatar } from './components/common';

const NAV = [
  { to: '/workitems', icon: 'workitems', label: 'Work items' },
  { to: '/boards', icon: 'board', label: 'Boards' },
  { to: '/backlogs', icon: 'backlog', label: 'Backlogs' },
  { to: '/sprints', icon: 'sprint', label: 'Sprints' },
];

export function App() {
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const signInRequired = useStore((s) => s.signInRequired);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    startApp().catch((err) => useStore.setState({ loadError: err instanceof Error ? err.message : String(err) }));
  }, []);

  if (loadError) {
    return (
      <div className="boot">
        <Icon name="warning" size={32} />
        <h2>Couldn't reach the server</h2>
        <p className="muted">{loadError}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (signInRequired) {
    return (
      <>
        <SignInScreen />
        <Toasts />
      </>
    );
  }
  if (!loaded) return <div className="boot muted">Loading…</div>;

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <SideNav collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div className="main">
        <TopBar />
        <div className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/backlogs/requirements" replace />} />
            <Route path="/workitems" element={<WorkItemsPage />} />
            <Route path="/boards" element={<Navigate to="/boards/requirements" replace />} />
            <Route path="/boards/:level" element={<BoardPage />} />
            <Route path="/backlogs" element={<Navigate to="/backlogs/requirements" replace />} />
            <Route path="/backlogs/:level" element={<BacklogPage />} />
            <Route path="/sprints" element={<SprintPage />} />
            <Route path="/sprints/:sprintId" element={<SprintPage />} />
            <Route path="/sprints/:sprintId/:view" element={<SprintPage />} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
      <WorkItemDialogHost />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}

function SideNav({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const project = useStore((s) => s.settings.projectName);
  const location = useLocation();
  return (
    <nav className="sidenav" aria-label="Main">
      <div className="sidenav-project" title={project}>
        <span className="project-badge">{project.slice(0, 1).toUpperCase() || 'P'}</span>
        {!collapsed && <span className="project-name">{project}</span>}
      </div>
      <div className="sidenav-section">{!collapsed && 'Boards'}</div>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={{ pathname: n.to, search: '' }}
          className={() => `sidenav-link ${location.pathname.startsWith(n.to) ? 'active' : ''}`}
          title={n.label}
        >
          <Icon name={n.icon} size={18} />
          {!collapsed && <span>{n.label}</span>}
        </NavLink>
      ))}
      <div className="sidenav-spacer" />
      <NavLink to="/settings" className={() => `sidenav-link ${location.pathname.startsWith('/settings') ? 'active' : ''}`} title="Project settings">
        <Icon name="settings" size={18} />
        {!collapsed && <span>Project settings</span>}
      </NavLink>
      <button className="sidenav-link sidenav-toggle" onClick={onToggle} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
        <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={18} />
      </button>
    </nav>
  );
}

function TopBar() {
  const settings = useStore((s) => s.settings);
  const members = useStore((s) => s.members);
  const currentUserId = useStore((s) => s.currentUserId);
  const connection = useStore((s) => s.connection);
  const signedIn = useStore((s) => !!s.auth?.enabled && !!s.auth.user);
  const items = useStore((s) => s.workItems);
  const { open } = useWorkItemDialog();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const me = members.find((m) => m.id === currentUserId);
  const location = useLocation();
  const section = NAV.find((n) => location.pathname.startsWith(n.to))?.label ?? (location.pathname.startsWith('/settings') ? 'Settings' : '');

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim().replace(/^#/, '');
    if (!text) return;
    const id = Number(text);
    if (Number.isInteger(id) && items.some((w) => w.id === id)) {
      open(id);
      setQ('');
      return;
    }
    navigate(`/workitems?q=${encodeURIComponent(text)}`);
    setQ('');
  };

  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span>{settings.projectName}</span>
        <Icon name="chevronRight" size={12} />
        <span>{settings.teamName}</span>
        {section && (
          <>
            <Icon name="chevronRight" size={12} />
            <strong>{section}</strong>
          </>
        )}
      </div>
      <form className="topbar-search" onSubmit={search} role="search">
        <Icon name="search" size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or type a work item ID" aria-label="Search work items" />
      </form>
      <span className={`connection connection-${connection}`} title={connection === 'live' ? 'Live updates connected' : connection === 'offline' ? 'Live updates disconnected - retrying' : 'Connecting'}>
        <span className="connection-dot" />
        {connection === 'offline' && 'Offline'}
      </span>
      {signedIn ? (
        <SignedInUser />
      ) : (
        <label className="user-switch" title="Acting as (recorded in history and comments)">
          <Avatar member={me} size={26} />
          <select value={currentUserId ?? ''} onChange={(e) => setCurrentUser(e.target.value)} aria-label="Current user">
            {!me && <option value="">Choose user…</option>}
            {members
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
      )}
    </header>
  );
}

/** With sign-in on, the top-right shows who you are, with password and sign-out options. */
function SignedInUser() {
  const user = useStore((s) => s.auth?.user);
  const me = useStore((s) => s.members.find((m) => m.id === s.auth?.user?.memberId));
  const menu = useMenu();
  const [changing, setChanging] = useState(false);
  if (!user) return null;
  const daysLeft = user.passwordExpiresAt ? Math.ceil((Date.parse(user.passwordExpiresAt) - Date.now()) / 86_400_000) : null;
  return (
    <>
      <button
        className="user-switch user-menu-btn"
        title={`Signed in as ${user.username}`}
        onClick={(e) =>
          menu.openAt(e, [
            { label: `Signed in as ${user.username}`, icon: 'person', disabled: true },
            ...(daysLeft != null ? [{ label: `Password expires in ${Math.max(daysLeft, 0)} day${daysLeft === 1 ? '' : 's'}`, disabled: true }] : []),
            { divider: true },
            { label: 'Change password…', icon: 'edit', onClick: () => setChanging(true) },
            { label: 'Sign out', icon: 'open', onClick: () => void signOut() },
          ])
        }
      >
        <Avatar member={me} size={26} />
        <span className="user-menu-name">{user.name}</span>
        {daysLeft != null && daysLeft <= 7 && (
          <span className="badge badge-danger" title="Your password expires soon">
            {Math.max(daysLeft, 0)}d
          </span>
        )}
        <Icon name="chevronDown" size={12} />
      </button>
      {menu.element}
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </>
  );
}
