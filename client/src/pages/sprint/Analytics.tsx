import { useMemo, useRef, useState } from 'react';
import { formatDayMonth } from '../../../../shared/dates';
import { computeBurndown, computeVelocity, type BurndownPoint } from '../../../../shared/burndown';
import { computeCapacity, computeSprintWork, sortSprints, sprintTimeframe } from '../../../../shared/sprints';
import type { Sprint } from '../../../../shared/types';
import { EmptyState } from '../../components/common';
import { formatHours, formatNumber } from '../../lib/format';
import { useToday } from '../../lib/hooks';
import { useStore } from '../../store';

export function Analytics({ sprint }: { sprint: Sprint }) {
  const items = useStore((s) => s.workItems);
  const sprints = useStore((s) => s.sprints);
  const capacity = useStore((s) => s.capacities.find((c) => c.sprintId === sprint.id));
  const workingDays = useStore((s) => s.settings.workingDays);
  const today = useToday();

  const burndown = useMemo(() => computeBurndown(sprint, items, workingDays, today), [sprint, items, workingDays, today]);
  const capacityLine = useMemo(
    () => burndown.map((p) => computeCapacity(sprint, capacity, workingDays, p.date).remainingCapacity),
    [burndown, sprint, capacity, workingDays],
  );
  const cap = computeCapacity(sprint, capacity, workingDays, today);
  const work = useMemo(() => computeSprintWork(items, sprint.id), [items, sprint.id]);
  const reqs = items.filter((w) => w.iterationId === sprint.id && (w.type === 'Product Backlog Item' || w.type === 'Bug') && w.state !== 'Removed');
  const doneEffort = reqs.filter((w) => w.state === 'Done').reduce((s, w) => s + (w.effort ?? 0), 0);
  const totalEffort = reqs.reduce((s, w) => s + (w.effort ?? 0), 0);
  const velocity = useMemo(() => {
    const dated = sortSprints(sprints).filter((s) => s.startDate && sprintTimeframe(s, today) !== 'future');
    return computeVelocity(dated.slice(-8), items);
  }, [sprints, items, today]);
  const avgVelocity = (() => {
    const past = velocity.filter((v) => sprints.find((s) => s.id === v.sprintId && sprintTimeframe(s, today) === 'past'));
    return past.length ? past.reduce((s, v) => s + v.completed, 0) / past.length : null;
  })();

  if (!sprint.startDate || !sprint.finishDate) {
    return <EmptyState icon="chart" title="Set sprint dates to see analytics" />;
  }

  return (
    <div className="sprint-view analytics">
      <div className="tiles">
        <Tile label="Completed effort" value={`${formatNumber(doneEffort)} / ${formatNumber(totalEffort)}`} sub="story points" />
        <Tile label="Backlog items done" value={`${reqs.filter((w) => w.state === 'Done').length} / ${reqs.length}`} sub="PBIs and bugs" />
        <Tile label="Remaining work" value={formatHours(work.total) || '0 h'} sub="unfinished tasks" />
        <Tile label="Remaining capacity" value={formatHours(cap.remainingCapacity) || '0 h'} sub={`${cap.remainingWorkingDays} working days left`} />
        {avgVelocity != null && <Tile label="Average velocity" value={formatNumber(Math.round(avgVelocity * 10) / 10)} sub="points per past sprint" />}
      </div>
      <div className="chart-card">
        <div className="chart-head">
          <div>
            <h3>Sprint burndown</h3>
            <div className="muted small">Remaining work (hours) per working day, reconstructed from work item history</div>
          </div>
        </div>
        {burndown.length ? <BurndownChart points={burndown} capacity={capacityLine} today={today} /> : <div className="muted pad">No working days in this sprint.</div>}
      </div>
      <div className="chart-card">
        <div className="chart-head">
          <div>
            <h3>Velocity</h3>
            <div className="muted small">Effort of backlog items per sprint</div>
          </div>
        </div>
        <VelocityChart data={velocity} currentId={sprint.id} />
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub muted small">{sub}</div>
    </div>
  );
}

const H = 260;
const PAD = { top: 16, right: 20, bottom: 32, left: 48 };

function niceMax(v: number) {
  if (v <= 0) return 10;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const observer = useRef<ResizeObserver | null>(null);
  const setRef = (el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (!el) return;
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    observer.current.observe(el);
  };
  return { setRef, width };
}

function Legend({ items }: { items: { label: string; className: string; kind: 'line' | 'swatch' }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label} className="legend-item">
          <span className={`legend-key ${i.kind} ${i.className}`} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function BurndownChart({ points, capacity, today }: { points: BurndownPoint[]; capacity: number[]; today: string }) {
  const { setRef, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.remaining ?? 0, p.ideal)), ...capacity));
  const iw = width - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const actual = points.map((p, i) => ({ p, i })).filter(({ p }) => p.remaining != null);
  const line = (pts: { x: number; y: number }[]) => pts.map((pt, i) => `${i ? 'L' : 'M'}${pt.x},${pt.y}`).join('');
  const actualPath = line(actual.map(({ p, i }) => ({ x: x(i), y: y(p.remaining!) })));
  const areaPath = actual.length ? `${actualPath}L${x(actual[actual.length - 1].i)},${y(0)}L${x(actual[0].i)},${y(0)}Z` : '';
  const idealPath = line(points.map((p, i) => ({ x: x(i), y: y(p.ideal) })));
  const capPath = line(capacity.map((c, i) => ({ x: x(i), y: y(c) })));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(iw / 70)));
  const hasCapacity = capacity.some((c) => c > 0);
  const last = actual[actual.length - 1];

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * iw;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round((rel / iw) * (points.length - 1)))));
  };

  return (
    <div className="chart viz-root" ref={setRef}>
      <div className="chart-controls">
        <Legend
          items={[
            { label: 'Remaining work', className: 's1', kind: 'swatch' },
            { label: 'Ideal trend', className: 'neutral', kind: 'line' },
            ...(hasCapacity ? [{ label: 'Available capacity', className: 's2', kind: 'line' as const }] : []),
          ]}
        />
        <button className="link-btn small" onClick={() => setTable(!table)}>
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <table className="grid data-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Remaining</th>
              <th>Ideal</th>
              {hasCapacity && <th>Capacity</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={p.date}>
                <td>{formatDayMonth(p.date)}</td>
                <td className="num">{p.remaining == null ? '—' : formatHours(p.remaining)}</td>
                <td className="num">{formatHours(Math.round(p.ideal * 10) / 10)}</td>
                {hasCapacity && <td className="num">{formatHours(capacity[i])}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-svg-wrap">
          <svg width={width} height={H} role="img" aria-label="Sprint burndown chart">
            {ticks.map((t) => (
              <g key={t}>
                <line className="gridline" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="axis-text" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 || i === points.length - 1 ? (
                <text key={p.date} className={`axis-text ${p.date === today ? 'strong' : ''}`} x={x(i)} y={H - 10} textAnchor="middle">
                  {formatDayMonth(p.date)}
                </text>
              ) : null,
            )}
            <path className="area s1" d={areaPath} />
            <path className="series-line neutral thin" d={idealPath} />
            {hasCapacity && <path className="series-line s2" d={capPath} />}
            <path className="series-line s1" d={actualPath} />
            {last && (
              <>
                <circle className="dot s1" cx={x(last.i)} cy={y(last.p.remaining!)} r={4.5} />
                <text className="value-label" x={x(last.i) + 8} y={y(last.p.remaining!) - 8}>
                  {formatHours(last.p.remaining)}
                </text>
              </>
            )}
            {hover != null && (
              <>
                <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} />
                {points[hover].remaining != null && <circle className="dot s1" cx={x(hover)} cy={y(points[hover].remaining!)} r={4.5} />}
              </>
            )}
            <rect x={PAD.left - 10} y={PAD.top} width={iw + 20} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>
          {hover != null && (
            <div className="tooltip" style={{ left: Math.min(x(hover) + 12, width - 180), top: PAD.top }}>
              <strong>{formatDayMonth(points[hover].date)}</strong>
              <div>
                <span className="legend-key swatch s1" /> Remaining: {points[hover].remaining == null ? '—' : formatHours(points[hover].remaining)}
              </div>
              <div>
                <span className="legend-key line neutral" /> Ideal: {formatHours(Math.round(points[hover].ideal * 10) / 10)}
              </div>
              {hasCapacity && (
                <div>
                  <span className="legend-key line s2" /> Capacity: {formatHours(capacity[hover])}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VelocityChart({ data, currentId }: { data: { sprintId: string; name: string; completed: number; incomplete: number }[]; currentId: string }) {
  const { setRef, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  if (!data.length) return <div className="muted pad">No started sprints yet.</div>;
  const max = niceMax(Math.max(...data.map((d) => d.completed + d.incomplete)));
  const iw = width - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const band = iw / data.length;
  const bw = Math.min(24, band * 0.5);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  // Column with a 4px rounded top and a square base.
  const column = (x0: number, top: number, bottom: number, rounded: boolean) => {
    const h = bottom - top;
    if (h <= 0) return '';
    const r = rounded ? Math.min(4, h, bw / 2) : 0;
    return `M${x0},${bottom}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${bottom}Z`;
  };
  return (
    <div className="chart viz-root" ref={setRef}>
      <div className="chart-controls">
        <Legend
          items={[
            { label: 'Completed', className: 's1', kind: 'swatch' },
            { label: 'Not completed', className: 'neutral', kind: 'swatch' },
          ]}
        />
        <button className="link-btn small" onClick={() => setTable(!table)}>
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {table ? (
        <table className="grid data-table">
          <thead>
            <tr>
              <th>Sprint</th>
              <th>Completed</th>
              <th>Not completed</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.sprintId}>
                <td>{d.name}</td>
                <td className="num">{formatNumber(d.completed)}</td>
                <td className="num">{formatNumber(d.incomplete)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-svg-wrap">
          <svg width={width} height={H} role="img" aria-label="Velocity chart">
            {ticks.map((t) => (
              <g key={t}>
                <line className="gridline" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="axis-text" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x0 = PAD.left + band * i + (band - bw) / 2;
              const completedTop = y(d.completed);
              const totalTop = y(d.completed + d.incomplete);
              // 2px surface gap between the stacked segments.
              const gap = d.completed > 0 && d.incomplete > 0 ? 2 : 0;
              return (
                <g key={d.sprintId} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={PAD.left + band * i} y={PAD.top} width={band} height={ih} fill="transparent" />
                  <path className="bar s1" d={column(x0, completedTop, y(0), d.incomplete === 0)} />
                  <path className="bar neutral" d={column(x0, totalTop, completedTop - gap, true)} />
                  {d.incomplete === 0 && d.completed > 0 && (
                    <text className="value-label" x={x0 + bw / 2} y={totalTop - 6} textAnchor="middle">
                      {formatNumber(d.completed)}
                    </text>
                  )}
                  <text className={`axis-text ${d.sprintId === currentId ? 'strong' : ''}`} x={x0 + bw / 2} y={H - 10} textAnchor="middle">
                    {d.name}
                  </text>
                </g>
              );
            })}
          </svg>
          {hover != null && (
            <div className="tooltip" style={{ left: Math.min(PAD.left + band * hover + band / 2 + 16, width - 180), top: PAD.top }}>
              <strong>{data[hover].name}</strong>
              <div>
                <span className="legend-key swatch s1" /> Completed: {formatNumber(data[hover].completed)}
              </div>
              <div>
                <span className="legend-key swatch neutral" /> Not completed: {formatNumber(data[hover].incomplete)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
