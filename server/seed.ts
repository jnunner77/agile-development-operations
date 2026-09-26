import { randomUUID } from 'node:crypto';
import { addDays, dayOfWeek, todayLocal, workingDaysBetween } from '../shared/dates';
import { stateDef, type WorkItemType } from '../shared/process';
import type { Database, FieldChange, Member, Sprint, SprintCapacity, WorkItem } from '../shared/types';
import { blankWorkItem, emptyDatabase } from './schema';

/**
 * Demo project used on first start so the boards have something to show. Dates are
 * relative to today and work item history is back-filled so burndown charts work.
 */
export function buildDemoDatabase(today: string = todayLocal()): Database {
  const db = emptyDatabase({ projectName: 'Fabrikam', teamName: 'Fabrikam Team', areaPaths: ['Fabrikam', 'Fabrikam\\Web', 'Fabrikam\\Mobile', 'Fabrikam\\Platform'] });

  const members: Member[] = [
    { id: randomUUID(), name: 'Alex Johnson', email: 'alex@fabrikam.example', color: '#0078d4', active: true },
    { id: randomUUID(), name: 'Priya Patel', email: 'priya@fabrikam.example', color: '#8764b8', active: true },
    { id: randomUUID(), name: 'Marcus Chen', email: 'marcus@fabrikam.example', color: '#00b294', active: true },
    { id: randomUUID(), name: 'Sofia Rossi', email: 'sofia@fabrikam.example', color: '#e3008c', active: true },
    { id: randomUUID(), name: 'Dana Kim', email: 'dana@fabrikam.example', color: '#ca5010', active: true },
  ];
  const [alex, priya, marcus, sofia, dana] = members;
  db.members = members;

  // Two-week sprints (Mon..Fri of the following week); today falls in the second one.
  const dow = dayOfWeek(today);
  const monday = addDays(today, -((dow + 6) % 7));
  const currentStart = dow >= 1 && dow <= 3 ? addDays(monday, -7) : monday;
  const sprints: Sprint[] = [-2, -1, 0, 1, 2].map((offset, idx) => {
    const start = addDays(currentStart, offset * 14);
    return { id: randomUUID(), name: `Sprint ${idx + 1}`, startDate: start, finishDate: addDays(start, 11), goal: '' };
  });
  sprints[2].goal = 'Customers can manage their own account details and see invoices in the portal.';
  sprints[3].goal = 'Offline mode beta on Android and iOS.';
  db.sprints = sprints;
  const [s1, s2, s3, s4] = sprints;

  const dev = (hours: number, activity = 'Development') => [{ activity, capacityPerDay: hours }];
  db.capacities = sprints.map<SprintCapacity>((s) => ({
    sprintId: s.id,
    teamDaysOff: [],
    members: [
      { memberId: alex.id, activities: dev(6), daysOff: [] },
      { memberId: priya.id, activities: dev(6), daysOff: [] },
      { memberId: marcus.id, activities: [{ activity: 'Development', capacityPerDay: 4 }, { activity: 'Deployment', capacityPerDay: 2 }], daysOff: [] },
      { memberId: sofia.id, activities: dev(5, 'Testing'), daysOff: [] },
      { memberId: dana.id, activities: dev(4, 'Design'), daysOff: [] },
    ],
  }));
  const currentCap = db.capacities[2];
  currentCap.members[1].daysOff = [{ start: addDays(s3.startDate!, 3), end: addDays(s3.startDate!, 4) }];
  currentCap.members[3].daysOff = [{ start: addDays(s3.startDate!, 9), end: addDays(s3.startDate!, 9) }];
  db.capacities[3].teamDaysOff = [{ start: addDays(s4.startDate!, 4), end: addDays(s4.startDate!, 4) }];

  let nextId = 1;
  let rank = 0;
  const at = (date: string, hour = 9) => `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const nowIso = new Date().toISOString();
  const clamp = (ts: string) => (ts > nowIso ? nowIso : ts);

  const make = (type: WorkItemType, title: string, fields: Partial<WorkItem> = {}, created = addDays(s1.startDate!, -10)) => {
    const createdAt = clamp(at(created, 8));
    const item = blankWorkItem({
      id: nextId++,
      type,
      title,
      areaPath: 'Fabrikam',
      stackRank: (rank += 1000),
      createdAt,
      createdBy: alex.name,
      changedAt: createdAt,
      changedBy: alex.name,
      ...fields,
    });
    item.reason = stateDef(type, item.state)?.reason ?? 'New';
    item.history.push({
      id: randomUUID(),
      changedBy: alex.name,
      changedAt: createdAt,
      note: 'Created',
      changes: [
        { field: 'title', oldValue: null, newValue: title },
        { field: 'state', oldValue: null, newValue: item.state },
        { field: 'iterationId', oldValue: null, newValue: item.iterationId },
        { field: 'remainingWork', oldValue: null, newValue: item.remainingWork },
      ],
    });
    db.workItems.push(item);
    return item;
  };

  /** Apply a change at a point in time, recording history like the server would. */
  const change = (item: WorkItem, date: string, hour: number, by: Member, patch: Partial<WorkItem>) => {
    const ts = clamp(at(date, hour));
    const changes: FieldChange[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const old = (item as unknown as Record<string, unknown>)[k];
      if (old === v) continue;
      changes.push({ field: k, oldValue: old ?? null, newValue: v ?? null });
      (item as unknown as Record<string, unknown>)[k] = v;
    }
    if (patch.state) {
      item.reason = stateDef(item.type, patch.state)?.reason ?? item.reason;
      if (patch.state === 'Done') item.closedAt = ts;
    }
    item.changedAt = ts;
    item.changedBy = by.name;
    item.history.push({ id: randomUUID(), changedBy: by.name, changedAt: ts, changes });
  };

  const p = (text: string) => `<p>${text}</p>`;
  const ul = (...lines: string[]) => `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;

  // ---- Portfolio ---------------------------------------------------------------
  const epicPortal = make('Epic', 'Customer self-service portal', {
    state: 'In Progress',
    priority: 1,
    effort: 80,
    businessValue: 90,
    timeCriticality: 70,
    startDate: s1.startDate,
    targetDate: s4.finishDate,
    description: p('Give customers a single place to manage their account, billing and support requests without calling the service desk.'),
    tags: ['Portal', 'FY26'],
  });
  const epicMobile = make('Epic', 'Mobile experience', {
    state: 'In Progress',
    priority: 2,
    effort: 60,
    businessValue: 70,
    description: p('Native-quality mobile experience including offline use and notifications.'),
    tags: ['Mobile'],
  });
  const epicPlatform = make('Epic', 'Platform reliability', {
    priority: 2,
    effort: 40,
    valueArea: 'Architectural',
    description: p('Improve the reliability, observability and recoverability of the platform.'),
    tags: ['Platform'],
  });

  const fAccount = make('Feature', 'Account management', { parentId: epicPortal.id, state: 'In Progress', effort: 21, businessValue: 80, tags: ['Portal'] });
  const fBilling = make('Feature', 'Billing & invoices', { parentId: epicPortal.id, state: 'In Progress', effort: 26, businessValue: 70, tags: ['Portal', 'Billing'] });
  const fSupport = make('Feature', 'Support requests', { parentId: epicPortal.id, effort: 13, businessValue: 40 });
  const fOffline = make('Feature', 'Offline mode', { parentId: epicMobile.id, effort: 20, businessValue: 60, tags: ['Mobile'], targetDate: s4.finishDate });
  const fPush = make('Feature', 'Push notifications', { parentId: epicMobile.id, effort: 8, businessValue: 30, tags: ['Mobile'] });
  const fObservability = make('Feature', 'Observability', { parentId: epicPlatform.id, effort: 13, valueArea: 'Architectural' });
  const fBackups = make('Feature', 'Automated backups', { parentId: epicPlatform.id, effort: 8, valueArea: 'Architectural', state: 'Done', closedAt: clamp(at(s2.finishDate!)) });

  // ---- Sprint 1 & 2 (completed) ------------------------------------------------
  const donePbi = (title: string, parent: WorkItem, sprint: Sprint, effort: number, who: Member, extra: Partial<WorkItem> = {}) => {
    const item = make('Product Backlog Item', title, { parentId: parent.id, effort, assignedTo: who.id, iterationId: sprint.id, state: 'Committed', ...extra });
    change(item, addDays(sprint.startDate!, 7), 15, who, { state: 'Done' });
    return item;
  };
  donePbi('Sign in with email and password', fAccount, s1, 5, alex);
  donePbi('Password reset via email link', fAccount, s1, 3, priya);
  donePbi('Nightly database backup job', fBackups, s1, 5, marcus, { tags: ['Ops'] });
  donePbi('Backup retention and restore runbook', fBackups, s2, 3, marcus);
  donePbi('View invoice history', fBilling, s2, 8, priya);
  donePbi('Structured logging for API', fObservability, s2, 5, alex, { tags: ['Ops'] });
  const oldBug = make('Bug', 'Session expires while typing a long form', {
    parentId: fAccount.id,
    iterationId: s2.id,
    assignedTo: sofia.id,
    effort: 2,
    severity: '2 - High',
    state: 'Committed',
    reproSteps: p('1. Sign in<br>2. Open profile edit form<br>3. Wait 20 minutes while typing<br>4. Click Save') + p('<b>Actual:</b> changes are lost and user is redirected to sign-in.'),
  });
  change(oldBug, addDays(s2.startDate!, 5), 11, sofia, { state: 'Done' });

  // ---- Sprint 3 (current) -------------------------------------------------------
  const sprintDays = workingDaysBetween(s3.startDate!, s3.finishDate!, db.settings.workingDays);
  const elapsed = sprintDays.filter((d) => d <= today);

  interface TaskSpec {
    title: string;
    who: Member;
    hours: number;
    activity?: string;
    /** Fraction of the elapsed sprint at which work progresses; 0..1 or undefined for untouched. */
    progress?: number;
    done?: boolean;
  }

  const sprintPbi = (
    type: 'Product Backlog Item' | 'Bug',
    title: string,
    parent: WorkItem,
    effort: number,
    who: Member,
    tasks: TaskSpec[],
    extra: Partial<WorkItem> = {},
  ) => {
    const pbi = make(type, title, { parentId: parent.id, effort, assignedTo: who.id, iterationId: s3.id, state: 'Approved', ...extra }, addDays(s3.startDate!, -12));
    change(pbi, s3.startDate!, 9, alex, { state: 'Committed' });
    for (const t of tasks) {
      const task = make(
        'Task',
        t.title,
        {
          parentId: pbi.id,
          iterationId: s3.id,
          assignedTo: t.who.id,
          activity: t.activity ?? 'Development',
          originalEstimate: t.hours,
          remainingWork: t.hours,
          completedWork: 0,
        },
        s3.startDate!,
      );
      if (t.progress === undefined || elapsed.length === 0) continue;
      const startIdx = Math.min(elapsed.length - 1, Math.floor(elapsed.length * t.progress * 0.5));
      change(task, elapsed[startIdx], 10, t.who, { state: 'In Progress' });
      const steps = Math.max(1, elapsed.length - startIdx - 1);
      let remaining = t.hours;
      for (let i = 1; i <= steps && startIdx + i < elapsed.length; i++) {
        const burn = Math.max(1, Math.round(t.hours / (steps + (t.done ? 0 : 1))));
        remaining = Math.max(t.done && i === steps ? 0 : 1, remaining - burn);
        change(task, elapsed[startIdx + i], 16, t.who, { remainingWork: remaining, completedWork: t.hours - remaining });
      }
      if (t.done) change(task, elapsed[elapsed.length - 1], 17, t.who, { state: 'Done', remainingWork: 0, completedWork: t.hours });
    }
    return pbi;
  };

  const profile = sprintPbi(
    'Product Backlog Item',
    'Edit profile details',
    fAccount,
    5,
    alex,
    [
      { title: 'Design profile edit form', who: dana, hours: 6, activity: 'Design', progress: 0, done: true },
      { title: 'Profile update API endpoint', who: alex, hours: 8, progress: 0.1, done: true },
      { title: 'Profile form front end', who: alex, hours: 10, progress: 0.4 },
      { title: 'Test profile editing', who: sofia, hours: 6, activity: 'Testing' },
    ],
    {
      description: p('As a customer, I want to update my contact details so that invoices and notifications reach me.'),
      acceptanceCriteria: ul('Name, phone and address can be changed', 'Email change requires re-verification', 'Validation errors are shown inline'),
      tags: ['Portal', 'UX'],
      businessValue: 60,
      dueDate: s3.finishDate,
    },
  );
  const invoices = sprintPbi(
    'Product Backlog Item',
    'Download invoice as PDF',
    fBilling,
    8,
    priya,
    [
      { title: 'PDF rendering service', who: priya, hours: 12, progress: 0.2 },
      { title: 'Download button and progress state', who: dana, hours: 4, activity: 'Design', progress: 0.6 },
      { title: 'Deploy renderer to staging', who: marcus, hours: 4, activity: 'Deployment' },
      { title: 'Verify PDFs against invoice template', who: sofia, hours: 5, activity: 'Testing' },
    ],
    {
      description: p('Customers need a PDF copy of each invoice for their records.'),
      acceptanceCriteria: ul('Each invoice row has a Download PDF action', 'PDF matches the approved invoice template', 'Download works for invoices older than 12 months'),
      tags: ['Billing'],
      originalEstimate: 25,
    },
  );
  sprintPbi(
    'Bug',
    'Invoice totals rounded incorrectly for multi-currency accounts',
    fBilling,
    3,
    marcus,
    [
      { title: 'Reproduce with EUR/GBP fixtures', who: marcus, hours: 2, progress: 0, done: true },
      { title: 'Fix rounding in totals calculation', who: marcus, hours: 4, progress: 0.3 },
      { title: 'Add regression tests', who: sofia, hours: 3, activity: 'Testing' },
    ],
    {
      severity: '2 - High',
      priority: 1,
      reproSteps:
        p('1. Sign in as a customer billed in EUR with a GBP secondary account') +
        p('2. Open Billing &gt; Invoices') +
        p('3. Compare invoice total with the sum of the line items') +
        p('<b>Expected:</b> totals match. <b>Actual:</b> total is off by 0.01 on some invoices.'),
      systemInfo: p('Chrome 128 / Windows 11. Production, tenant EU-2.'),
      foundInBuild: '2026.9.1',
      tags: ['Billing', 'Customer reported'],
    },
  );
  sprintPbi(
    'Product Backlog Item',
    'Health check endpoint and uptime alerts',
    fObservability,
    3,
    marcus,
    [
      { title: 'Add /healthz endpoint', who: marcus, hours: 3, progress: 0.5 },
      { title: 'Configure uptime alert rules', who: marcus, hours: 3, activity: 'Deployment' },
    ],
    { tags: ['Ops'], valueArea: 'Architectural' },
  );

  // ---- Sprint 4 (next) -----------------------------------------------------------
  const planned = (title: string, parent: WorkItem, effort: number, extra: Partial<WorkItem> = {}) =>
    make('Product Backlog Item', title, { parentId: parent.id, effort, iterationId: s4.id, state: 'Approved', ...extra });
  const offlineSync = planned('Queue changes while offline and sync on reconnect', fOffline, 8, {
    assignedTo: priya.id,
    description: p('Users in low-connectivity areas lose work today. Queue writes locally and replay them when the network is back.'),
    acceptanceCriteria: ul('Edits made offline are visible immediately', 'Queued edits sync within 30s of reconnecting', 'Conflicts are surfaced to the user'),
    tags: ['Mobile'],
  });
  planned('Offline indicator banner', fOffline, 2, { assignedTo: dana.id, tags: ['Mobile', 'UX'] });
  planned('Pay an invoice by card', fBilling, 8, { tags: ['Billing'] });

  // ---- Product backlog (unscheduled) ---------------------------------------------
  make('Product Backlog Item', 'Open a support request from the portal', { parentId: fSupport.id, effort: 5, businessValue: 40 });
  make('Product Backlog Item', 'Attach screenshots to support requests', { parentId: fSupport.id, effort: 3 });
  make('Product Backlog Item', 'Register device for push notifications', { parentId: fPush.id, effort: 3, tags: ['Mobile'] });
  make('Product Backlog Item', 'Notification preferences page', { parentId: fPush.id, effort: 5, tags: ['Mobile', 'UX'] });
  make('Product Backlog Item', 'Distributed tracing across services', { parentId: fObservability.id, effort: 8, valueArea: 'Architectural', tags: ['Ops'] });
  make('Bug', 'Profile photo upload fails for HEIC images', {
    parentId: fAccount.id,
    effort: 2,
    severity: '3 - Medium',
    reproSteps: p('Upload a .heic photo from an iPhone on the profile page. An "Unsupported file" error appears.'),
    tags: ['Customer reported'],
  });
  make('Product Backlog Item', 'Export account data (GDPR)', { effort: 5, priority: 1, dueDate: addDays(today, 45), tags: ['Compliance'] });
  make('Product Backlog Item', 'Dark mode for the portal', { effort: 3, priority: 3, tags: ['UX'] });

  // Some cross-links and discussion to make the form interesting.
  db.links.push(
    { id: randomUUID(), sourceId: offlineSync.id, targetId: profile.id, type: 'Related', comment: 'Shares the profile sync API', createdBy: alex.name, createdAt: clamp(at(s3.startDate!)) },
    { id: randomUUID(), sourceId: invoices.id, targetId: offlineSync.id, type: 'Predecessor', comment: '', createdBy: priya.name, createdAt: clamp(at(s3.startDate!)) },
  );
  profile.comments.push(
    { id: randomUUID(), author: sofia.name, text: p('Should the email change flow block saving other fields until verified?'), createdAt: clamp(at(elapsed[0] ?? s3.startDate!, 11)), editedAt: null },
    { id: randomUUID(), author: alex.name, text: p('No - save the other fields right away and show a pending banner for the email. Updated the acceptance criteria.'), createdAt: clamp(at(elapsed[1] ?? s3.startDate!, 9)), editedAt: null },
  );
  invoices.hyperlinks.push({ id: randomUUID(), url: 'https://example.com/design/invoice-template', comment: 'Approved invoice template', addedBy: priya.name, addedAt: clamp(at(s3.startDate!)) });

  db.nextWorkItemId = nextId;
  return db;
}
