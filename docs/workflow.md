# Workflow

## Branching

- `main`: protected integration branch for reviewed work.
- `slice/*`: focused implementation slices.
- `spike/*`: short-lived research or platform validation branches.

## Delivery Style

Each slice should leave the repo in a runnable or typechecked state. Avoid combining desktop, API, and web changes into the same slice unless the contract requires it.

## Local Checkpoints

Use local commits freely to avoid sitting on uncommitted work. Publishing and shipping should stay separate from personal checkpoint cadence.

## Immediate Priorities

1. Add persistence to the API.
2. Stand up the desktop Tauri workspace.
3. Add the web viewer workspace.