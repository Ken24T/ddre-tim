import { useEffect, useState } from "react";
import { dashboardData, formatHoursLabel } from "./dashboardData.js";

interface HealthPayload {
  service: string;
  status: string;
  now: string;
}

type HealthState =
  | { phase: "loading" }
  | { phase: "ready"; payload: HealthPayload }
  | { phase: "error"; message: string };

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeStyle: "medium"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function App() {
  const [healthState, setHealthState] = useState<HealthState>({ phase: "loading" });

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

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Time in Motion</p>
        <h1>{dashboardData.employeeName} dashboard prototype</h1>
        <p className="lead">
          This first dashboard slice is driven from the imported historical seed so we can shape the manager-facing
          reporting surface before the live read models are finished.
        </p>
        <div className="hero-meta">
          <span>Imported from {dashboardData.sourceFile}</span>
          <span>{dashboardData.dateRangeLabel}</span>
        </div>
      </section>

      <section className="summary-grid">
        {dashboardData.summaryCards.map((card) => (
          <article className="panel stat-card" key={card.label}>
            <p className="panel-label">{card.label}</p>
            <h2>{card.value}</h2>
            <p>{card.helper}</p>
          </article>
        ))}
      </section>

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
          <p className="panel-label">Seed refresh</p>
          <h2>{new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(dashboardData.importedAt))}</h2>
          <p>
            This prototype reads from the generated historical seed. Refresh it after workbook changes with <code>npm
            run import:tim-records</code>.
          </p>
        </article>

        <article className="panel">
          <p className="panel-label">Top department</p>
          <h2>{dashboardData.departmentBreakdown[0]?.label ?? "No data"}</h2>
          <p>{dashboardData.departmentBreakdown[0] ? `${formatHoursLabel(dashboardData.departmentBreakdown[0].hours)} across ${dashboardData.departmentBreakdown[0].dayCount} days` : "No imported records available yet."}</p>
        </article>

        <article className="panel panel-span-2">
          <p className="panel-label">Department breakdown</p>
          <h2>Hours by department</h2>
          <div className="breakdown-list">
            {dashboardData.departmentBreakdown.map((row) => (
              <div className="breakdown-row" key={row.label}>
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.dayCount} days · {row.recordCount} records</span>
                </div>
                <strong>{formatHoursLabel(row.hours)}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <p className="panel-label">Recent workdays</p>
          <h2>Latest imported dates</h2>
          <div className="day-list">
            {dashboardData.recentDays.map((day) => (
              <div className="day-row" key={day.workDate}>
                <div>
                  <strong>{day.label}</strong>
                  <span>{day.topActivity}</span>
                </div>
                <div className="day-metrics">
                  <strong>{formatHoursLabel(day.hours)}</strong>
                  <span>{day.departmentCount} depts</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel panel-span-2">
          <p className="panel-label">Activity breakdown</p>
          <h2>Top imported activities</h2>
          <div className="breakdown-list">
            {dashboardData.activityBreakdown.map((row) => (
              <div className="breakdown-row" key={row.label}>
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.dayCount} days · {row.recordCount} records</span>
                </div>
                <strong>{formatHoursLabel(row.hours)}</strong>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <p className="panel-label">Monthly totals</p>
          <h2>Imported trend</h2>
          <div className="month-list">
            {dashboardData.monthlyTotals.map((month) => (
              <div className="month-row" key={month.monthKey}>
                <span>{month.label}</span>
                <strong>{formatHoursLabel(month.hours)}</strong>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}