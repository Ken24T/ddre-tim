#!/usr/bin/env node

const net = require("node:net");
const {
  loadPolicy,
  logItem,
  logSection
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

main(loadPolicy(), options)
  .then((activeCount) => {
    if (options.json) {
      process.stdout.write("\n");
    }

    process.exit(activeCount > 0 ? 0 : 0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Runtime advisory warning: ${message}`);
    process.exit(0);
  });

async function main(config, cliOptions) {
  const advisory = config && config.handover && config.handover.runtimeAdvisory;
  const listeners = getConfiguredListeners(advisory);

  if (cliOptions.list) {
    printConfiguredListeners(listeners, cliOptions);
    return 0;
  }

  const timeoutMs = Number.isInteger(cliOptions.timeoutMs) ? cliOptions.timeoutMs : 350;
  const results = await Promise.all(listeners.map((listener) => probeListener(listener, timeoutMs)));
  const activeResults = results.filter((result) => result.active);

  if (cliOptions.json) {
    process.stdout.write(JSON.stringify({
      activeCount: activeResults.length,
      listeners: results,
      mode: advisory && typeof advisory.mode === "string" ? advisory.mode : "report-only"
    }, null, 2));
    return activeResults.length;
  }

  logSection("Runtime listener advisory");
  logItem("Mode", advisory && typeof advisory.mode === "string" ? advisory.mode : "report-only");
  logItem("Configured listeners", String(results.length));
  logItem("Active listeners", String(activeResults.length));

  if (results.length === 0) {
    console.log("No runtime listeners are configured for handover advisory.");
    return 0;
  }

  console.log("Detected listeners:");

  for (const result of results) {
    const status = result.active ? "active" : "inactive";
    const detail = result.active ? result.label : `${result.label} (${result.reason})`;
    console.log(`- ${result.host}:${result.port} — ${status} — ${detail}`);
  }

  if (activeResults.length > 0) {
    console.log(
      "Advice: Report only. If you are handing over runtime ownership as well as git state, stop these listeners separately before moving machines."
    );
  } else {
    console.log("Advice: No configured runtime listeners are currently active.");
  }

  console.log("This advisory never blocks handover.");
  return activeResults.length;
}

function getConfiguredListeners(advisory) {
  if (!advisory || advisory.enabled !== true || !Array.isArray(advisory.listeners)) {
    return [];
  }

  return advisory.listeners
    .map((listener) => normaliseListener(listener))
    .filter(Boolean);
}

function normaliseListener(listener) {
  if (!listener || typeof listener !== "object") {
    return null;
  }

  const port = Number.parseInt(String(listener.port), 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const host = typeof listener.host === "string" && listener.host.trim().length > 0
    ? listener.host.trim()
    : "127.0.0.1";
  const label = typeof listener.label === "string" && listener.label.trim().length > 0
    ? listener.label.trim()
    : `listener ${port}`;

  return {
    host,
    label,
    port
  };
}

function probeListener(listener, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: listener.host,
      port: listener.port
    });

    let settled = false;

    const complete = (payload) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve({
        ...listener,
        ...payload
      });
    };

    socket.setTimeout(timeoutMs, () => {
      complete({ active: false, reason: "timeout" });
    });

    socket.once("connect", () => {
      complete({ active: true, reason: "connected" });
    });

    socket.once("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : "unreachable";
      complete({ active: false, reason: String(code) });
    });
  });
}

function printConfiguredListeners(listeners, cliOptions) {
  if (cliOptions.json) {
    process.stdout.write(JSON.stringify({ listeners }, null, 2));
    return;
  }

  logSection("Configured runtime listeners");

  if (listeners.length === 0) {
    console.log("- none");
    return;
  }

  for (const listener of listeners) {
    console.log(`- ${listener.host}:${listener.port} — ${listener.label}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    json: false,
    list: false,
    timeoutMs: 350
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--timeout-ms") {
      const rawValue = argv[index + 1];
      const timeoutMs = Number.parseInt(String(rawValue), 10);

      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("--timeout-ms requires a positive integer value.");
      }

      parsed.timeoutMs = timeoutMs;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option '${arg}'.`);
  }

  return parsed;
}