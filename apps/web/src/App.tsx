import { useEffect, useState, type FormEvent } from "react";
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
      label: "Worked days",
      value: String(data.stats.workdayCount),
      helper: `${formatHoursLabel(data.stats.averageHoursPerDay)} average per day`
    },
    {
      label: "Departments",
      value: String(data.stats.departmentCount),
      helper: `${data.stats.activityCount} activities in scope`
    },
    {
      label: "Scope",
      value: data.filters.selectedDepartment ?? "All departments",
      helper: data.dateRangeLabel
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

export default function App() {
  const [healthState, setHealthState] = useState<HealthState>({ phase: "loading" });
  const [dashboardState, setDashboardState] = useState<DashboardState>({ phase: "loading" });
  const [draftFilters, setDraftFilters] = useState<FilterFormState>(createEmptyFilters());
  const [appliedFilters, setAppliedFilters] = useState<DashboardQueryValues>({});

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
  }, [appliedFilters.department, appliedFilters.from, appliedFilters.to]);

  function handleApplyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAppliedFilters({
      department: draftFilters.department || undefined,
      from: draftFilters.from || undefined,
      to: draftFilters.to || undefined
    });
  }

  function handleResetFilters(): void {
    setDraftFilters(createEmptyFilters());
    setAppliedFilters({});
  }

  const dashboardData = dashboardState.phase === "ready" || dashboardState.phase === "refreshing" ? dashboardState.data : null;
  const summaryCards = dashboardData ? buildSummaryCards(dashboardData) : [];
  const monthlyChartMax = dashboardData ? Math.max(...dashboardData.monthlyTotals.map((month) => month.hours), 0) : 0;
  const departmentChartRows = dashboardData?.departmentBreakdown.slice(0, 5) ?? [];
  const activityRows = dashboardData?.activityBreakdown.slice(0, 8) ?? [];
  const departmentRows = dashboardData?.departmentBreakdown.slice(0, 8) ?? [];
  const departmentChartMax = Math.max(...departmentChartRows.map((row) => row.hours), 0);
  const dashboardBusy = dashboardState.phase === "loading" || dashboardState.phase === "refreshing";

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Time in Motion</p>
        <h1>{dashboardData?.employeeName ?? "Manager dashboard"}</h1>
        <p className="lead">
          The dashboard now reads from the API instead of importing seed data directly, giving us a real manager-facing
          read model to shape while persistence work continues underneath.
        </p>
        <div className="hero-meta">
          <span>{dashboardData ? `Imported from ${dashboardData.sourceFile}` : "Loading imported history"}</span>
          <span>{dashboardData ? dashboardData.dateRangeLabel : "Preparing dashboard scope"}</span>
          <span>{dashboardState.phase === "refreshing" ? "Refreshing view" : "API-backed read model"}</span>
        </div>
      </section>

      <section className="panel control-panel">
        <div className="control-copy">
          <p className="panel-label">Manager filters</p>
          <h2>Department and date window</h2>
          <p>Start narrowing the imported history before manager scopes and saved views become persistent features.</p>
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

      <section className="grid">
        <article className="panel panel-health panel-span-2">
          <p className="panel-label">API health</p>
          {healthState.phase === "loading" ? <h2>Checking local API...</h2> : null}
          {healthState.phase === "ready" ? (
            <>
              <h2>{healthState.payload.status.toUpperCase()}</h2>
              <p>Service: {healthState.payload.service}</p>
              <p>Checked: {formatTimestamp(healthState.payload.now)}</p>
            </>
          ) : null}
          {healthState.phase === "error" ? (
            <>
              <h2>API unavailable</h2>
              <p>{healthState.message}</p>
              <p>Start the local API with <code>npm run dev:api</code>.</p>
            </>
          ) : null}
        </article>

        <article className="panel">
          <p className="panel-label">Read model source</p>
          {dashboardData ? (
            <>
              <h2>{formatTimestamp(dashboardData.importedAt)}</h2>
              <p>
                The API is serving this dashboard from <code>{dashboardData.sourceFile}</code>. Refresh the seed after
                workbook changes with <code>npm run import:tim-records</code>.
              </p>
            </>
          ) : (
            <>
              <h2>Loading dashboard...</h2>
              <p>Waiting for the API read model to return imported history.</p>
            </>
          )}
        </article>

        {dashboardData ? (
          <>
            <article className="panel panel-span-2 chart-panel">
              <p className="panel-label">Monthly trend</p>
              <h2>Imported hours across the selected window</h2>
              {dashboardData.monthlyTotals.length > 0 ? (
                <div className="trend-chart" role="img" aria-label="Monthly hours chart">
                  {dashboardData.monthlyTotals.map((month) => (
                    <div className="trend-column" key={month.monthKey} title={`${month.label}: ${formatHoursLabel(month.hours)}`}>
                      <span className="trend-value">{formatHoursLabel(month.hours)}</span>
                      <span className="trend-bar" style={{ height: barHeight(month.hours, monthlyChartMax) }} />
                      <span className="trend-label">{month.label}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No monthly data in the current filter window.</p>
              )}
            </article>

            <article className="panel chart-panel">
              <p className="panel-label">Department chart</p>
              <h2>Where the time is landing</h2>
              {departmentChartRows.length > 0 ? (
                <div className="share-chart" role="img" aria-label="Department hours comparison chart">
                  {departmentChartRows.map((row) => (
                    <div className="share-row" key={row.label}>
                      <div className="share-copy">
                        <strong>{row.label}</strong>
                        <span>{row.dayCount} days · {row.recordCount} records</span>
                      </div>
                      <div className="share-track-wrap">
                        <div className="share-track">
                          <span className="share-fill" style={{ width: barWidth(row.hours, departmentChartMax) }} />
                        </div>
                        <strong>{formatHoursLabel(row.hours)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No department data in the current filter window.</p>
              )}
            </article>

            <article className="panel">
              <p className="panel-label">Recent workdays</p>
              <h2>Latest imported dates</h2>
              <div className="data-list">
                {dashboardData.recentDays.length > 0 ? (
                  dashboardData.recentDays.map((day) => (
                    <div className="data-row" key={day.workDate}>
                      <div>
                        <strong>{day.label}</strong>
                        <span>{day.topActivity}</span>
                      </div>
                      <div className="data-row-meta">
                        <strong>{formatHoursLabel(day.hours)}</strong>
                        <span>{day.departmentCount} depts</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p>No recent days are available for the current filter window.</p>
                )}
              </div>
            </article>

            <article className="panel panel-span-2">
              <p className="panel-label">Department breakdown</p>
              <h2>Hours by department</h2>
              <div className="data-list">
                {departmentRows.length > 0 ? (
                  departmentRows.map((row) => (
                    <div className="data-row" key={row.label}>
                      <div>
                        <strong>{row.label}</strong>
                        <span>{row.dayCount} days · {row.recordCount} records</span>
                      </div>
                      <strong>{formatHoursLabel(row.hours)}</strong>
                    </div>
                  ))
                ) : (
                  <p>No department breakdown is available for the current filter window.</p>
                )}
              </div>
            </article>

            <article className="panel panel-span-2">
              <p className="panel-label">Activity breakdown</p>
              <h2>Top imported activities</h2>
              <div className="data-list">
                {activityRows.length > 0 ? (
                  activityRows.map((row) => (
                    <div className="data-row" key={row.label}>
                      <div>
                        <strong>{row.label}</strong>
                        <span>{row.dayCount} days · {row.recordCount} records</span>
                      </div>
                      <strong>{formatHoursLabel(row.hours)}</strong>
                    </div>
                  ))
                ) : (
                  <p>No activity breakdown is available for the current filter window.</p>
                )}
              </div>
            </article>
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