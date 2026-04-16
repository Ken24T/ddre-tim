import { useEffect, useState } from "react";

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
        <h1>Office-hosted dashboard slice</h1>
        <p className="lead">
          This local Vite workspace gives the repo a real browser surface for testing while the manager dashboard
          read models are still being built.
        </p>
      </section>

      <section className="grid">
        <article className="panel panel-health">
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
          <p className="panel-label">Current testing scope</p>
          <h2>Browser shell only</h2>
          <p>
            The dashboard workspace is intentionally minimal: local UI shell, API reachability check, and a place to
            grow manager-facing reporting views without waiting on the desktop app.
          </p>
        </article>

        <article className="panel">
          <p className="panel-label">Runtime model</p>
          <h2>DDNUC-11 first</h2>
          <p>
            The current deployment target remains office-hosted on DDNUC-11, with the dashboard viewed from the office
            LAN and remote workers syncing through the API only.
          </p>
        </article>
      </section>
    </main>
  );
}