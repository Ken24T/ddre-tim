import { useEffect, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import {
  fetchDashboardSnapshot,
  formatHoursLabel,
  formatTimestamp,
  type DashboardQueryValues,
  type DashboardResponse
} from "./dashboardClient.js";

interface HealthPayload {
  service: string;
  status: string;
  now: string;
}

interface FilterFormState {
  department: string;
  from: string;
  to: string;
}

type HealthState =
  | { phase: "loading" }
  | { phase: "ready"; payload: HealthPayload }
  | { phase: "error"; message: string };

type DashboardState =
  | { phase: "loading" }
  | { phase: "refreshing"; data: DashboardResponse }
  | { phase: "ready"; data: DashboardResponse }
  | { phase: "error"; message: string };

type DashboardFocus = "all" | "monthly" | "users" | "departments" | "activities";

const dashboardFocusOptions: Array<{ id: DashboardFocus; label: string; helper: string; cardCount: number }> = [
  { id: "all", label: "All charts", helper: "Full dashboard", cardCount: 7 },
  { id: "monthly", label: "Monthly trends", helper: "Month by month", cardCount: 1 },
  { id: "users", label: "Users", helper: "Contribution view", cardCount: 1 },
  { id: "departments", label: "Departments", helper: "Share and split", cardCount: 2 },
  { id: "activities", label: "Activities", helper: "What users do", cardCount: 2 }
];

function createEmptyFilters(): FilterFormState {
  return {
    department: "",
    from: "",
    to: ""
  };
}

function buildSummaryCards(data: DashboardResponse): Array<{ label: string; value: string; helper: string }> {
  return [
    {
      label: "Imported hours",
      value: formatHoursLabel(data.stats.totalHours),
      helper: `${data.stats.recordCount} combined daily records`
    },
    {
      label: "Selected users",
      value: String(data.stats.selectedUserCount),
      helper: data.scopeLabel
    },
    {
      label: "User-days",
      value: String(data.stats.userDayCount),
      helper: `${formatHoursLabel(data.stats.averageHoursPerUserDay)} average per user-day`
    },
    {
      label: "Departments",
      value: String(data.stats.departmentCount),
      helper: `${data.stats.activityCount} activities in scope`
    }
  ];
}

function barHeight(hours: number, maxHours: number): string {
  if (maxHours === 0) {
    return "10%";
  }

  return `${Math.max(14, (hours / maxHours) * 100)}%`;
}

function barWidth(hours: number, maxHours: number): string {
  if (maxHours === 0) {
    return "0%";
  }

  return `${Math.max(8, (hours / maxHours) * 100)}%`;
}

const pieChartCenterX = 110;
const pieChartCenterY = 94;
const pieChartRadiusX = 92;
const pieChartRadiusY = 68;
const pieChartDepth = 18;

function polarToCartesian(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  angleInDegrees: number
): { x: number; y: number } {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: centerX + radiusX * Math.cos(angleInRadians),
    y: centerY + radiusY * Math.sin(angleInRadians)
  };
}

function describePieSlicePath(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  startAngle: number,
  endAngle: number
): string {
  const start = polarToCartesian(centerX, centerY, radiusX, radiusY, endAngle);
  const end = polarToCartesian(centerX, centerY, radiusX, radiusY, startAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${centerX} ${centerY}`,
    `L ${end.x} ${end.y}`,
    `A ${radiusX} ${radiusY} 0 ${largeArcFlag} 1 ${start.x} ${start.y}`,
    "Z"
  ].join(" ");
}

function shadeHexColor(color: string, multiplier: number): string {
  const normalized = color.replace("#", "");

  if (normalized.length !== 6) {
    return color;
  }

  const channels = [0, 2, 4].map((offset) => {
    const parsed = Number.parseInt(normalized.slice(offset, offset + 2), 16);
    const nextValue = Math.max(0, Math.min(255, Math.round(parsed * multiplier)));

    return nextValue.toString(16).padStart(2, "0").toUpperCase();
  });

  return `#${channels.join("")}`;
}

interface BreakdownPieSlice {
  label: string;
  hours: number;
  share: number;
  color: string;
  sideColor: string;
  topPath: string;
  bottomPath: string;
}

interface BreakdownRow {
  label: string;
  hours: number;
}

interface BreakdownPieOptions {
  maxRows?: number;
  collapseRemainingLabel?: string;
  colorByLabel?: Map<string, string>;
}

interface UserActivityPieCard {
  userId: string;
  label: string;
  color: string;
  totalHours: number;
  slices: BreakdownPieSlice[];
}

const breakdownPiePalette = ["#EEF8FC", "#D9EAF2", "#B9D9EA", "#92D0C8", "#7CB8DD", "#6EA6CF", "#5E8FC3", "#4B79B4"];

function buildBreakdownColorMap(rows: BreakdownRow[], extraLabels: string[] = []): Map<string, string> {
  const labels = [...rows.map((row) => row.label)];

  for (const label of extraLabels) {
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }

  return new Map(labels.map((label, index) => [label, breakdownPiePalette[index % breakdownPiePalette.length] ?? "#6EA6CF"]));
}

function buildBreakdownPieSlices(rows: BreakdownRow[], options: BreakdownPieOptions = {}): BreakdownPieSlice[] {
  const maxRows = options.maxRows ?? rows.length;
  const baseRows = rows.slice(0, maxRows);
  const remainingRows = rows.slice(maxRows);
  const remainingHours = remainingRows.reduce((total, row) => total + row.hours, 0);
  const chartRows =
    options.collapseRemainingLabel && remainingHours > 0
      ? [...baseRows, { label: options.collapseRemainingLabel, hours: Number(remainingHours.toFixed(2)) }]
      : baseRows;
  const totalHours = chartRows.reduce((total, row) => total + row.hours, 0);
  let currentAngle = 0;

  return chartRows.map((row, index) => {
    const share = totalHours === 0 ? 0 : row.hours / totalHours;
    const startAngle = currentAngle;
    const endAngle = currentAngle + share * 360;
    currentAngle = endAngle;
    const color = options.colorByLabel?.get(row.label) ?? breakdownPiePalette[index % breakdownPiePalette.length] ?? "#6EA6CF";

    return {
      label: row.label,
      hours: row.hours,
      share,
      color,
      sideColor: shadeHexColor(color, 0.68),
      topPath: describePieSlicePath(pieChartCenterX, pieChartCenterY, pieChartRadiusX, pieChartRadiusY, startAngle, endAngle),
      bottomPath: describePieSlicePath(
        pieChartCenterX,
        pieChartCenterY + pieChartDepth,
        pieChartRadiusX,
        pieChartRadiusY,
        startAngle,
        endAngle
      )
    };
  });
}

function buildUserActivityPieCards(
  activityRows: DashboardResponse["activityUserBreakdown"],
  userRows: DashboardResponse["userBreakdown"],
  activityColorByLabel: Map<string, string>
): UserActivityPieCard[] {
  const activitiesByUser = new Map<string, BreakdownRow[]>();

  for (const activityRow of activityRows) {
    for (const segment of activityRow.segments) {
      const userActivities = activitiesByUser.get(segment.userId) ?? [];
      userActivities.push({
        label: activityRow.label,
        hours: segment.hours
      });
      activitiesByUser.set(segment.userId, userActivities);
    }
  }

  return userRows
    .map((userRow) => {
      const userActivities = [...(activitiesByUser.get(userRow.userId) ?? [])].sort((left, right) => {
        return right.hours - left.hours || left.label.localeCompare(right.label, "en-AU");
      });

      return {
        userId: userRow.userId,
        label: userRow.label,
        color: userRow.color,
        totalHours: userRow.hours,
        slices: buildBreakdownPieSlices(userActivities, {
          maxRows: 5,
          collapseRemainingLabel: "Other",
          colorByLabel: activityColorByLabel
        })
      };
    })
    .filter((card) => card.slices.length > 0);
}

function BreakdownPieLayout({
  slices,
  totalHours,
  ariaLabel
}: {
  slices: BreakdownPieSlice[];
  totalHours: number;
  ariaLabel: string;
}) {
  return (
    <div className="pie-chart-layout">
      <div className="pie-chart-wrap">
        <svg className="pie-chart-svg" viewBox="0 0 220 220" role="img" aria-label={ariaLabel}>
          <ellipse className="pie-chart-shadow" cx={pieChartCenterX} cy={pieChartCenterY + pieChartDepth + 56} rx="78" ry="22" />
          <ellipse className="pie-chart-base pie-chart-base-bottom" cx={pieChartCenterX} cy={pieChartCenterY + pieChartDepth} rx={pieChartRadiusX} ry={pieChartRadiusY} />
          {slices.length === 1 ? (
            <>
              <ellipse
                className="pie-chart-slice pie-chart-slice-bottom"
                cx={pieChartCenterX}
                cy={pieChartCenterY + pieChartDepth}
                rx={pieChartRadiusX}
                ry={pieChartRadiusY}
                fill={slices[0]?.sideColor}
              />
              <ellipse
                className="pie-chart-slice pie-chart-slice-top"
                cx={pieChartCenterX}
                cy={pieChartCenterY}
                rx={pieChartRadiusX}
                ry={pieChartRadiusY}
                fill={slices[0]?.color}
              >
                <title>{`${slices[0]?.label ?? "Department"}: ${formatHoursLabel(slices[0]?.hours ?? 0)}`}</title>
              </ellipse>
            </>
          ) : (
            <>
              <g className="pie-chart-bottom-layer">
                {slices.map((slice) => (
                  <path className="pie-chart-slice pie-chart-slice-bottom" d={slice.bottomPath} fill={slice.sideColor} key={`${slice.label}-bottom`} />
                ))}
              </g>
              <g className="pie-chart-top-layer">
                {slices.map((slice) => (
                  <path className="pie-chart-slice pie-chart-slice-top" d={slice.topPath} fill={slice.color} key={slice.label}>
                    <title>{`${slice.label}: ${formatHoursLabel(slice.hours)} (${(slice.share * 100).toFixed(1)}%)`}</title>
                  </path>
                ))}
              </g>
            </>
          )}
        </svg>

        <div className="pie-chart-total">
          <span>Total</span>
          <strong>{formatHoursLabel(totalHours)}</strong>
        </div>
      </div>

      <div className="pie-chart-legend">
        {slices.map((slice) => (
          <div className="pie-chart-row" key={slice.label}>
            <div className="pie-chart-row-copy">
              <span className="legend-swatch" style={{ background: slice.color }} />
              <strong>{slice.label}</strong>
            </div>
            <div className="pie-chart-row-values">
              <span>{(slice.share * 100).toFixed(1)}%</span>
              <strong>{formatHoursLabel(slice.hours)}</strong>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [healthState, setHealthState] = useState<HealthState>({ phase: "loading" });
  const [dashboardState, setDashboardState] = useState<DashboardState>({ phase: "loading" });
  const [draftFilters, setDraftFilters] = useState<FilterFormState>(createEmptyFilters());
  const [appliedFilters, setAppliedFilters] = useState<DashboardQueryValues>({});
  const [dashboardFocus, setDashboardFocus] = useState<DashboardFocus>("all");

  useEffect(() => {
    let cancelled = false;

    async function loadHealth(): Promise<void> {
      try {
        const response = await fetch("/health");

        if (!response.ok) {
          throw new Error(`Health check failed with status ${response.status}`);
        }

        const payload = (await response.json()) as HealthPayload;

        if (!cancelled) {
          setHealthState({ phase: "ready", payload });
        }
      } catch (error) {
        if (!cancelled) {
          setHealthState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    setDashboardState((current) => {
      if (current.phase === "ready" || current.phase === "refreshing") {
        return {
          phase: "refreshing",
          data: current.data
        };
      }

      return { phase: "loading" };
    });

    async function loadDashboard(): Promise<void> {
      try {
        const payload = await fetchDashboardSnapshot(appliedFilters);

        if (!cancelled) {
          setDashboardState({ phase: "ready", data: payload });
          setDraftFilters({
            department: payload.filters.selectedDepartment ?? "",
            from: payload.filters.selectedFrom,
            to: payload.filters.selectedTo
          });
        }
      } catch (error) {
        if (!cancelled) {
          setDashboardState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadDashboard();

    return () => {
      cancelled = true;
    };
  }, [appliedFilters.department, appliedFilters.from, appliedFilters.to, appliedFilters.userIds?.join("|")]);

  function handleApplyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAppliedFilters({
      department: draftFilters.department || undefined,
      from: draftFilters.from || undefined,
      to: draftFilters.to || undefined,
      userIds: appliedFilters.userIds
    });
  }

  function handleResetFilters(): void {
    setDraftFilters(createEmptyFilters());
    setAppliedFilters({});
  }

  function handleAllUsersClick(): void {
    setAppliedFilters((current) => ({
      ...current,
      userIds: undefined
    }));
  }

  function handleUserChipClick(userId: string, event: MouseEvent<HTMLButtonElement>): void {
    if (!dashboardData) {
      return;
    }

    const currentSelection = dashboardData.filters.selectedUserIds;
    let nextSelection: string[];

    if (event.ctrlKey || event.metaKey) {
      nextSelection = currentSelection.includes(userId)
        ? currentSelection.filter((selectedUserId) => selectedUserId !== userId)
        : [...currentSelection, userId];
    } else {
      nextSelection = [userId];
    }

    const normalizedSelection = nextSelection.length === 0 || nextSelection.length === dashboardData.filters.availableUsers.length
      ? undefined
      : nextSelection;

    setAppliedFilters((current) => ({
      ...current,
      userIds: normalizedSelection
    }));
  }

  const dashboardData = dashboardState.phase === "ready" || dashboardState.phase === "refreshing" ? dashboardState.data : null;
  const summaryCards = dashboardData ? buildSummaryCards(dashboardData) : [];
  const monthlyChartMax = dashboardData ? Math.max(...dashboardData.monthlyUserTotals.map((month) => month.totalHours), 0) : 0;
  const selectedUsers = dashboardData?.filters.availableUsers.filter((user) => user.isSelected) ?? [];
  const userRows = dashboardData?.userBreakdown ?? [];
  const departmentPieSlices = buildBreakdownPieSlices(dashboardData?.departmentBreakdown ?? [], {
    maxRows: 5,
    collapseRemainingLabel: "Other"
  });
  const departmentPieTotal = departmentPieSlices.reduce((total, slice) => total + slice.hours, 0);
  const activityBreakdownRows = dashboardData?.activityBreakdown ?? [];
  const activityRows = activityBreakdownRows.slice(0, 8) ?? [];
  const departmentUserRows = dashboardData?.departmentUserBreakdown.slice(0, 8) ?? [];
  const departmentUserLegendUsers = selectedUsers.filter((user) => {
    return departmentUserRows.some((row) => row.segments.some((segment) => segment.userId === user.id));
  });
  const activityColorByLabel = buildBreakdownColorMap(activityBreakdownRows, ["Other"]);
  const activityPieSlices = buildBreakdownPieSlices(activityRows, {
    colorByLabel: activityColorByLabel
  });
  const activityPieTotal = activityPieSlices.reduce((total, slice) => total + slice.hours, 0);
  const activityUserPieCards = buildUserActivityPieCards(dashboardData?.activityUserBreakdown ?? [], userRows, activityColorByLabel);
  const userChartMax = Math.max(...userRows.map((row) => row.hours), 0);
  const dashboardBusy = dashboardState.phase === "loading" || dashboardState.phase === "refreshing";
  const apiStatusTone = healthState.phase === "ready" ? "online" : healthState.phase === "error" ? "offline" : "checking";
  const apiStatusLabel =
    healthState.phase === "ready" ? "API connected" : healthState.phase === "error" ? "API unavailable" : "Checking API";
  const apiStatusMeta =
    healthState.phase === "ready"
      ? `${healthState.payload.service} responding`
      : healthState.phase === "error"
        ? "Open for connection details"
        : "Waiting for local health check";
  const showMonthlyCharts = dashboardFocus === "all" || dashboardFocus === "monthly";
  const showUserCharts = dashboardFocus === "all" || dashboardFocus === "users";
  const showDepartmentCharts = dashboardFocus === "all" || dashboardFocus === "departments";
  const showActivityCharts = dashboardFocus === "all" || dashboardFocus === "activities";

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-bar">
          <p className="eyebrow">Time in Motion</p>

          <details className={`api-status-flyout is-${apiStatusTone}`}>
            <summary className="api-status-trigger">
              <span className="api-status-indicator" aria-hidden="true" />
              <span className="api-status-copy">
                <strong>{apiStatusLabel}</strong>
                <small>{apiStatusMeta}</small>
              </span>
            </summary>

            <div className="api-status-popover">
              <div className="api-status-section">
                <p className="panel-label">API connection</p>
                {healthState.phase === "loading" ? <p>Checking the local API connection.</p> : null}
                {healthState.phase === "ready" ? (
                  <>
                    <p>Status: {healthState.payload.status.toUpperCase()}</p>
                    <p>Service: {healthState.payload.service}</p>
                    <p>Checked: {formatTimestamp(healthState.payload.now)}</p>
                  </>
                ) : null}
                {healthState.phase === "error" ? (
                  <>
                    <p>{healthState.message}</p>
                    <p>Start the local API with <code>npm run dev:api</code>.</p>
                  </>
                ) : null}
              </div>

              <div className="api-status-section api-status-section-secondary">
                <p className="panel-label">Read model</p>
                {dashboardData ? (
                  <>
                    <p>Imported: {formatTimestamp(dashboardData.importedAt)}</p>
                    <p>Source: <code>{dashboardData.sourceFile}</code></p>
                    <p>{dashboardData.scopeLabel} within {dashboardData.filters.selectedDepartment ?? "all departments"}.</p>
                  </>
                ) : dashboardState.phase === "error" ? (
                  <>
                    <p>{dashboardState.message}</p>
                    <p>The API responded, but the dashboard read model did not load successfully.</p>
                  </>
                ) : (
                  <p>Waiting for the dashboard read model to finish loading.</p>
                )}
              </div>
            </div>
          </details>
        </div>

        <h1>DDRE TiM Dashboard</h1>
        <p className="lead">
          This dashboard turns day-to-day activity data into a practical view of how work is moving across the business.
          Used thoughtfully, it can be an invaluable resource for healthier planning, clearer conversations, and steady
          company development without losing sight of the people behind the work.
        </p>
      </section>

      <section className="panel control-panel">
        <div className="control-copy">
          <p className="panel-label">Manager filters</p>
          <h2>Users, department, and date window</h2>
          <p>Plain click isolates one user. Ctrl/Cmd-click adds or removes extra users from the same reporting scope.</p>
        </div>

        <div className="control-tools">
          <div className="user-filter-bank">
            <div className="user-filter-header">
              <span>User scope</span>
              <strong>{dashboardData?.scopeLabel ?? "Loading users"}</strong>
            </div>

            <div className="user-chip-list">
              <button
                className={`user-chip${dashboardData && dashboardData.filters.selectedUserIds.length === dashboardData.filters.availableUsers.length ? " is-active" : ""}`}
                disabled={dashboardBusy && !dashboardData}
                onClick={handleAllUsersClick}
                type="button"
              >
                <span>All users</span>
                <small>{dashboardData ? formatHoursLabel(dashboardData.stats.totalHours) : "..."}</small>
              </button>

              {(dashboardData?.filters.availableUsers ?? []).map((user) => (
                <button
                  className={`user-chip${user.isSelected ? " is-active" : ""}`}
                  disabled={dashboardBusy && !dashboardData}
                  key={user.id}
                  onClick={(event) => {
                    handleUserChipClick(user.id, event);
                  }}
                  style={{ "--chip-accent": user.color } as CSSProperties}
                  type="button"
                >
                  <span>{user.displayName}</span>
                  <small>{formatHoursLabel(user.totalHours)}</small>
                </button>
              ))}
            </div>

            <p className="user-filter-hint">Selected users stay in scope while you adjust department or date.</p>
          </div>

          <form className="filter-form" onSubmit={handleApplyFilters}>
            <label>
              <span>Department</span>
              <select
                value={draftFilters.department}
                onChange={(event) => {
                  setDraftFilters((current) => ({
                    ...current,
                    department: event.target.value
                  }));
                }}
              >
                <option value="">All departments</option>
                {(dashboardData?.filters.availableDepartments ?? []).map((department) => (
                  <option key={department} value={department}>
                    {department}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>From</span>
              <input
                max={dashboardData?.filters.maxDate}
                min={dashboardData?.filters.minDate}
                type="date"
                value={draftFilters.from}
                onChange={(event) => {
                  setDraftFilters((current) => ({
                    ...current,
                    from: event.target.value
                  }));
                }}
              />
            </label>

            <label>
              <span>To</span>
              <input
                max={dashboardData?.filters.maxDate}
                min={dashboardData?.filters.minDate}
                type="date"
                value={draftFilters.to}
                onChange={(event) => {
                  setDraftFilters((current) => ({
                    ...current,
                    to: event.target.value
                  }));
                }}
              />
            </label>

            <div className="filter-actions">
              <button className="button button-primary" disabled={dashboardBusy} type="submit">
                {dashboardState.phase === "refreshing" ? "Refreshing..." : "Apply filters"}
              </button>
              <button className="button" disabled={dashboardBusy && !dashboardData} onClick={handleResetFilters} type="button">
                Reset
              </button>
            </div>
          </form>
        </div>
      </section>

      {dashboardData ? (
        <section className="summary-grid">
          {summaryCards.map((card) => (
            <article className="panel stat-card" key={card.label}>
              <p className="panel-label">{card.label}</p>
              <h2>{card.value}</h2>
              <p>{card.helper}</p>
            </article>
          ))}
        </section>
      ) : null}

      {dashboardData ? (
        <section className="panel focus-panel">
          <div className="focus-copy">
            <p className="panel-label">Dashboard focus</p>
            <p className="focus-hint">Show a chart group without changing the users, department, or date scope.</p>
          </div>

          <div className="focus-chip-list" role="group" aria-label="Dashboard focus controls">
            {dashboardFocusOptions.map((option) => (
              <button
                aria-pressed={dashboardFocus === option.id}
                className={`focus-chip${dashboardFocus === option.id ? " is-active" : ""}`}
                key={option.id}
                onClick={() => {
                  setDashboardFocus(option.id);
                }}
                type="button"
              >
                <span>{option.label}</span>
                <span className="focus-chip-meta">
                  <small>{option.helper}</small>
                  <em>{`${option.cardCount} card${option.cardCount === 1 ? "" : "s"}`}</em>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className={`grid${dashboardFocus === "all" ? "" : " is-focused"}`}>
        {dashboardData ? (
          <>
            {showMonthlyCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Monthly trend</p>
                <h2>Stacked hours by user</h2>
                {dashboardData.monthlyUserTotals.length > 0 ? (
                  <>
                    <div className="trend-chart" role="img" aria-label="Monthly stacked user hours chart">
                      {dashboardData.monthlyUserTotals.map((month) => (
                        <div className="trend-column" key={month.monthKey}>
                          <span className="trend-value">{formatHoursLabel(month.totalHours)}</span>
                          <span className="trend-stack" style={{ height: barHeight(month.totalHours, monthlyChartMax) }}>
                            {month.segments.map((segment) => (
                              <span
                                className="trend-segment"
                                key={segment.userId}
                                title={`${segment.label}: ${formatHoursLabel(segment.hours)}`}
                                style={{
                                  background: segment.color,
                                  height: `${month.totalHours === 0 ? 0 : (segment.hours / month.totalHours) * 100}%`
                                }}
                              />
                            ))}
                          </span>
                          <span className="trend-label">{month.label}</span>
                        </div>
                      ))}
                    </div>

                    <div className="chart-legend">
                      {selectedUsers.map((user) => (
                        <div className="legend-item" key={user.id}>
                          <span className="legend-swatch" style={{ background: user.color }} />
                          <span>{user.displayName}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p>No monthly data in the current filter window.</p>
                )}
              </article>
            ) : null}

            {showUserCharts ? (
              <article className="panel chart-panel">
                <p className="panel-label">User comparison</p>
                <h2>Selected user contribution</h2>
                {userRows.length > 0 ? (
                  <div className="share-chart" role="img" aria-label="User hours comparison chart">
                    {userRows.map((row) => (
                      <div className="share-row" key={row.userId}>
                        <div className="share-copy">
                          <strong>{row.label}</strong>
                          <span>{row.dayCount} days · {row.recordCount} records</span>
                        </div>
                        <div className="share-track-wrap">
                          <div className="share-track">
                            <span className="share-fill" style={{ width: barWidth(row.hours, userChartMax), background: row.color }} />
                          </div>
                          <strong>{formatHoursLabel(row.hours)}</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>No user data in the current filter window.</p>
                )}
              </article>
            ) : null}

            {showDepartmentCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Department chart</p>
                <h2>Where the selected users are spending time</h2>
                {departmentPieSlices.length > 0 ? (
                  <BreakdownPieLayout slices={departmentPieSlices} totalHours={departmentPieTotal} ariaLabel="Department share 3D pie chart" />
                ) : (
                  <p>No department data in the current filter window.</p>
                )}
              </article>
            ) : null}

            {showDepartmentCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Department by user</p>
                <h2>How each department is split across selected users</h2>
                {departmentUserRows.length > 0 ? (
                  <>
                    <div className="split-by-user-chart" role="img" aria-label="Department by user stacked chart">
                      {departmentUserRows.map((row) => (
                        <div className="share-row department-user-row" key={row.label}>
                          <div className="share-copy">
                            <strong>{row.label}</strong>
                            <span>{row.dayCount} days · {row.recordCount} records</span>
                          </div>

                          <div className="share-track-wrap split-by-user-track-wrap">
                            <div className="split-by-user-track">
                              {row.segments.map((segment) => (
                                <span
                                  className="split-by-user-segment"
                                  key={segment.userId}
                                  title={`${segment.label}: ${formatHoursLabel(segment.hours)}`}
                                  style={{
                                    background: segment.color,
                                    width: `${row.totalHours === 0 ? 0 : (segment.hours / row.totalHours) * 100}%`
                                  }}
                                />
                              ))}
                            </div>

                            <strong>{formatHoursLabel(row.totalHours)}</strong>
                          </div>
                        </div>
                      ))}
                    </div>

                    {departmentUserLegendUsers.length > 0 ? (
                      <div className="chart-legend">
                        {departmentUserLegendUsers.map((user) => (
                          <div className="legend-item" key={user.id}>
                            <span className="legend-swatch" style={{ background: user.color }} />
                            <span>{user.displayName}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p>No department-by-user data is available for the current filter window.</p>
                )}
              </article>
            ) : null}

            {showActivityCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Activity breakdown</p>
                <h2>Top imported activities</h2>
                {activityPieSlices.length > 0 ? (
                  <BreakdownPieLayout slices={activityPieSlices} totalHours={activityPieTotal} ariaLabel="Activity breakdown 3D pie chart" />
                ) : (
                  <p>No activity breakdown is available for the current filter window.</p>
                )}
              </article>
            ) : null}

            {showActivityCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Activity by user</p>
                <h2>What selected users are spending time doing</h2>
                {activityUserPieCards.length > 0 ? (
                  <>
                    <div className="user-activity-pies" role="img" aria-label="Activity breakdown pie charts by user">
                      {activityUserPieCards.map((card) => (
                        <div className="user-activity-card" key={card.userId}>
                          <div className="user-activity-card-header">
                            <div className="user-activity-card-title">
                              <span className="legend-swatch" style={{ background: card.color }} />
                              <strong>{card.label}</strong>
                            </div>
                            <span className="user-activity-card-total">{formatHoursLabel(card.totalHours)}</span>
                          </div>

                          <BreakdownPieLayout
                            slices={card.slices}
                            totalHours={card.totalHours}
                            ariaLabel={`${card.label} activity breakdown pie chart`}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p>No activity-by-user data is available for the current filter window.</p>
                )}
              </article>
            ) : null}
          </>
        ) : null}

        {dashboardState.phase === "error" ? (
          <article className="panel panel-span-2">
            <p className="panel-label">Dashboard load</p>
            <h2>Dashboard unavailable</h2>
            <p>{dashboardState.message}</p>
            <p>The API is up, but the dashboard read model did not return successfully.</p>
          </article>
        ) : null}
      </section>
    </main>
  );
}