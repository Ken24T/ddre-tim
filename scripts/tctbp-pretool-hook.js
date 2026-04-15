const chunks = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(chunks.join("") || "{}");
    const decision = evaluatePayload(payload);

    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            "TCTBP safety hook could not parse the tool request. Confirm before continuing.",
          additionalContext:
            error instanceof Error ? error.message : "Unknown hook parse error"
        }
      })}\n`
    );
  }
});

function evaluatePayload(payload) {
  const toolName = String(payload.tool_name || "");
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const rawCommand = extractCommand(toolInput);

  if (!isTerminalLikeTool(toolName) || !rawCommand) {
    return allow();
  }

  const normalized = normalizeCommand(rawCommand);
  const match = findRisk(normalized);

  if (!match) {
    return allow();
  }

  return ask(match.reason);
}

function isTerminalLikeTool(toolName) {
  return new Set(["run_in_terminal", "create_and_run_task"]).has(toolName);
}

function extractCommand(toolInput) {
  if (typeof toolInput.command === "string") {
    const args = Array.isArray(toolInput.args)
      ? toolInput.args.filter((value) => typeof value === "string")
      : [];

    return [toolInput.command, ...args].join(" ").trim();
  }

  return "";
}

function normalizeCommand(command) {
  return command.toLowerCase().replace(/\s+/g, " ").trim();
}

function findRisk(command) {
  const risks = [
    {
      pattern: /(^|[;&|])\s*git\s+reset\s+--hard(\s|$)/,
      reason: "TCTBP safety hook flagged 'git reset --hard'. This can discard local work and requires explicit confirmation."
    },
    {
      pattern: /(^|[;&|])\s*git\s+checkout\s+--(\s|$)/,
      reason: "TCTBP safety hook flagged 'git checkout --'. This can overwrite local changes and requires explicit confirmation."
    },
    {
      pattern: /(^|[;&|])\s*git\s+restore\b[^\n]*\s--(staged|worktree|source=|source\s)/,
      reason: "TCTBP safety hook flagged a destructive 'git restore' usage. Confirm before continuing."
    },
    {
      pattern: /(^|[;&|])\s*git\s+clean\b[^\n]*\s-f/,
      reason: "TCTBP safety hook flagged 'git clean'. This can permanently delete untracked files and requires explicit confirmation."
    },
    {
      pattern: /(^|[;&|])\s*git\s+push\b[^\n]*\s--force(?:-with-lease)?(\s|$)/,
      reason: "TCTBP safety hook flagged a force-push. History-rewriting pushes require explicit confirmation."
    },
    {
      pattern: /(^|[;&|])\s*git\s+push\b[^\n]*\s--delete(\s|$)/,
      reason: "TCTBP safety hook flagged a remote deletion push. Confirm before deleting remote refs."
    },
    {
      pattern: /(^|[;&|])\s*git\s+branch\s+-d{1,2}(\s|$)/,
      reason: "TCTBP safety hook flagged branch deletion. Confirm before deleting local branches."
    },
    {
      pattern: /(^|[;&|])\s*git\s+tag\s+-d(\s|$)/,
      reason: "TCTBP safety hook flagged tag deletion. Confirm before deleting release tags."
    },
    {
      pattern: /(^|[;&|])\s*git\s+remote\s+(add|remove|rename|set-url)(\s|$)/,
      reason: "TCTBP safety hook flagged remote modification. Remote changes require explicit confirmation."
    },
    {
      pattern: /(^|[;&|])\s*git\s+rebase(\s|$)/,
      reason: "TCTBP safety hook flagged 'git rebase'. History-rewriting operations require explicit confirmation."
    },
    {
      pattern: /(^|[;&|])\s*git\s+stash\s+(drop|clear|pop)(\s|$)/,
      reason: "TCTBP safety hook flagged stash mutation. Confirm before dropping or applying stash entries."
    },
    {
      pattern: /(^|[;&|])\s*git\s+update-ref\b[^\n]*\s-d(\s|$)/,
      reason: "TCTBP safety hook flagged ref deletion. Confirm before removing git refs."
    }
  ];

  return risks.find((risk) => risk.pattern.test(command));
}

function allow() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow"
    }
  };
}

function ask(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
      additionalContext:
        "TCTBP safety hook escalated a risky git command for explicit approval under the repo's no-code-loss policy."
    }
  };
}