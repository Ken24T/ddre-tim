#!/usr/bin/env node

/**
 * tctbp-run-ticket.js — Preview-first ticket management runner.
 *
 * Supports create, report, and triage subcommands. Tickets are stored in a
 * configurable JSON file. All write operations are preview-first and require
 * explicit --apply.
 *
 * Usage:
 *   node scripts/tctbp-run-ticket.js create --title "..." --category "..." --description "..."
 *   node scripts/tctbp-run-ticket.js report <stale|hygiene|summary>
 *   node scripts/tctbp-run-ticket.js triage [ticket-id|all]
 *   node scripts/tctbp-run-ticket.js --list
 *
 * Configuration in .github/TCTBP.json:
 *   "ticket": {
 *     "ticketsFile": "path/to/tickets.json",   // optional, defaults to .tctbp/tickets.json
 *     "requireExplicitApply": true
 *   }
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  fail,
  loadPolicy,
  logItem,
  logSection,
  repoRoot
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));
const policy = loadPolicy();
const ticketConfig = policy.ticket || {};

if (options.list) {
  printUsage(0);
}

if (!options.subcommand) {
  console.error("Missing subcommand: create, report, or triage.");
  printUsage(1);
}

main(policy, options).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main(config, cliOptions) {
  switch (cliOptions.subcommand) {
    case "create":
      await handleCreate(config, cliOptions);
      break;
    case "report":
      await handleReport(config, cliOptions);
      break;
    case "triage":
      await handleTriage(config, cliOptions);
      break;
    default:
      fail(`Unknown subcommand '${cliOptions.subcommand}'. Expected create, report, or triage.`);
  }
}

// ── Ticket file resolution ──────────────────────────────────────────────────

function resolveTicketsFile(config) {
  const configured = config.ticket && typeof config.ticket.ticketsFile === "string" && config.ticket.ticketsFile.trim().length > 0
    ? config.ticket.ticketsFile.trim()
    : null;

  if (configured) {
    return path.resolve(repoRoot, configured);
  }

  return path.join(repoRoot, ".tctbp", "tickets.json");
}

function readTickets(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    fail(`Could not read tickets from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeTickets(filePath, tickets) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(tickets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function generateTicketId(tickets, prefix = "T") {
  let maxNum = 0;

  for (const ticket of tickets) {
    if (!ticket || typeof ticket.id !== "string") {
      continue;
    }

    const match = ticket.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > maxNum) {
        maxNum = num;
      }
    }
  }

  return `${prefix}-${String(maxNum + 1).padStart(4, "0")}`;
}

// ── Create ──────────────────────────────────────────────────────────────────

async function handleCreate(config, cliOptions) {
  const title = cliOptions.title || "";
  const category = cliOptions.category || "general";
  const description = cliOptions.description || "";

  if (!title) {
    fail("Ticket creation requires --title.");
  }

  const ticketsFile = resolveTicketsFile(config);
  const tickets = readTickets(ticketsFile);
  const newId = generateTicketId(tickets);

  const newTicket = {
    id: newId,
    title,
    category,
    description,
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    statusHistory: [
      {
        status: "open",
        timestamp: new Date().toISOString(),
        note: "Ticket created."
      }
    ],
    comments: []
  };

  logSection("Ticket Preview");
  logItem("ID", newTicket.id);
  logItem("Title", newTicket.title);
  logItem("Category", newTicket.category);
  logItem("Description", newTicket.description);
  logItem("Status", newTicket.status);
  logItem("File", ticketsFile);

  if (!cliOptions.apply) {
    console.log("\nPreview only. Use --apply to write this ticket.");
    return;
  }

  tickets.push(newTicket);
  writeTickets(ticketsFile, tickets);
  console.log(`\nTicket ${newId} created.`);
}

// ── Report ──────────────────────────────────────────────────────────────────

async function handleReport(config, cliOptions) {
  const reportType = cliOptions.reportType || "summary";
  const ticketsFile = resolveTicketsFile(config);
  const tickets = readTickets(ticketsFile);

  if (tickets.length === 0) {
    console.log("No tickets found.");
    return;
  }

  switch (reportType) {
    case "stale":
      await reportStale(tickets);
      break;
    case "hygiene":
      await reportHygiene(tickets);
      break;
    case "summary":
    default:
      await reportSummary(tickets);
      break;
  }
}

async function reportSummary(tickets) {
  const byStatus = {};
  const byCategory = {};

  for (const ticket of tickets) {
    if (!ticket || typeof ticket !== "object") {
      continue;
    }

    const status = ticket.status || "unknown";
    const category = ticket.category || "uncategorized";

    byStatus[status] = (byStatus[status] || 0) + 1;
    byCategory[category] = (byCategory[category] || 0) + 1;
  }

  logSection("Ticket Summary");
  logItem("Total", String(tickets.length));

  console.log("\nBy status:");
  for (const [status, count] of Object.entries(byStatus).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  console.log("\nBy category:");
  for (const [category, count] of Object.entries(byCategory).sort()) {
    console.log(`  ${category}: ${count}`);
  }

  // Show recent unresolved
  const unresolved = tickets
    .filter((t) => t && t.status === "open")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 5);

  if (unresolved.length > 0) {
    console.log("\nRecent open tickets:");
    for (const ticket of unresolved) {
      console.log(`  ${ticket.id}: ${ticket.title} [${ticket.category}]`);
    }
  }
}

async function reportStale(tickets) {
  const now = new Date();
  const staleThresholdMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const stale = tickets.filter((t) => {
    if (!t || t.status !== "open") {
      return false;
    }

    const updated = new Date(t.updatedAt || t.createdAt);
    return now - updated > staleThresholdMs;
  });

  logSection("Stale Tickets");
  logItem("Threshold", "30 days since last update");

  if (stale.length === 0) {
    console.log("No stale tickets found.");
    return;
  }

  logItem("Count", String(stale.length));
  console.log("");

  for (const ticket of stale) {
    const updated = new Date(ticket.updatedAt || ticket.createdAt);
    const daysAgo = Math.floor((now - updated) / (24 * 60 * 60 * 1000));
    console.log(`  ${ticket.id}: ${ticket.title} [${daysAgo} days since update]`);
  }
}

async function reportHygiene(tickets) {
  const issues = [];

  for (const ticket of tickets) {
    if (!ticket || typeof ticket !== "object") {
      continue;
    }

    if (!ticket.title || ticket.title.trim().length === 0) {
      issues.push(`${ticket.id}: missing title`);
    }

    if (!ticket.description || ticket.description.trim().length === 0) {
      issues.push(`${ticket.id}: missing description`);
    }

    if (!ticket.category) {
      issues.push(`${ticket.id}: missing category`);
    }
  }

  logSection("Ticket Hygiene");

  if (issues.length === 0) {
    console.log("All tickets pass hygiene checks.");
    return;
  }

  logItem("Issues found", String(issues.length));
  console.log("");

  for (const issue of issues) {
    console.log(`  - ${issue}`);
  }
}

// ── Triage ──────────────────────────────────────────────────────────────────

async function handleTriage(config, cliOptions) {
  const ticketsFile = resolveTicketsFile(config);
  const tickets = readTickets(ticketsFile);

  if (tickets.length === 0) {
    console.log("No tickets to triage.");
    return;
  }

  const targetId = cliOptions.triageTarget;
  const targetTickets = targetId && targetId !== "all"
    ? tickets.filter((t) => t && t.id === targetId)
    : tickets.filter((t) => t && t.status === "open");

  if (targetTickets.length === 0) {
    console.log(targetId ? `Ticket ${targetId} not found.` : "No open tickets to triage.");
    return;
  }

  logSection("Triage");

  for (const ticket of targetTickets) {
    console.log(`\n${ticket.id}: ${ticket.title}`);
    console.log(`  Status: ${ticket.status}`);
    console.log(`  Category: ${ticket.category || "uncategorized"}`);
    console.log(`  Description: ${ticket.description || "none"}`);
    console.log(`  Created: ${ticket.createdAt || "unknown"}`);
    console.log(`  Updated: ${ticket.updatedAt || "unknown"}`);

    if (ticket.comments && ticket.comments.length > 0) {
      console.log(`  Comments: ${ticket.comments.length}`);
    }

    if (ticket.statusHistory && ticket.statusHistory.length > 1) {
      const lastChange = ticket.statusHistory[ticket.statusHistory.length - 1];
      console.log(`  Last status change: ${lastChange.status} (${lastChange.timestamp})`);
    }
  }

  console.log(`\n${targetTickets.length} ticket(s) to review.`);
}

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = {
    subcommand: null,
    list: false,
    apply: false,
    title: null,
    category: null,
    description: null,
    reportType: null,
    triageTarget: null
  };

  // First positional arg is the subcommand
  if (argv.length > 0 && !argv[0].startsWith("--")) {
    parsed.subcommand = argv.shift();
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--list":
        parsed.list = true;
        break;
      case "--apply":
        parsed.apply = true;
        break;
      case "--title": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          fail("--title requires a value.");
        }
        parsed.title = value;
        index += 1;
        break;
      }
      case "--category": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          fail("--category requires a value.");
        }
        parsed.category = value;
        index += 1;
        break;
      }
      case "--description": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          fail("--description requires a value.");
        }
        parsed.description = value;
        index += 1;
        break;
      }
      default:
        // Positional args after subcommand: report type or triage target
        if (!parsed.reportType && parsed.subcommand === "report" && !arg.startsWith("--")) {
          parsed.reportType = arg;
        } else if (!parsed.triageTarget && parsed.subcommand === "triage" && !arg.startsWith("--")) {
          parsed.triageTarget = arg;
        }
        break;
    }
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-ticket.js <create|report|triage> [options]");
  console.log("");
  console.log("Create:");
  console.log("  node scripts/tctbp-run-ticket.js create --title \"...\" --category \"...\" --description \"...\" [--apply]");
  console.log("");
  console.log("Report:");
  console.log("  node scripts/tctbp-run-ticket.js report <summary|stale|hygiene>");
  console.log("");
  console.log("Triage:");
  console.log("  node scripts/tctbp-run-ticket.js triage [ticket-id|all]");
  console.log("");
  console.log("Options:");
  console.log("  --apply      Write changes (required for create)");
  console.log("  --list       Show this help");
  process.exit(exitCode);
}
