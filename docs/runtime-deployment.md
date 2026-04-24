# Runtime Deployment

## Current Target

The active deployment target is still the office-hosted runtime on `DDNUC-11`.

The current local GNOME slice proves the same runtime pieces can be built and run together on the workstation before the office service model is finalized:

- Fastify API from compiled `apps/api/dist`
- local file-backed API state under `infra/local-state/` unless `DATABASE_URL` is configured
- dashboard preview from the built web workspace
- native Tauri desktop release binary with the embedded desktop frontend

This is a local user-level runtime scaffold, not the final office production deployment. It intentionally avoids privileged installs, database exposure, and automatic login changes unless those flags are requested explicitly.

## Validated GNOME Host

Validation on the current workstation:

- Ubuntu GNOME Wayland session
- GNOME Shell present
- `ubuntu-appindicators@ubuntu.com` enabled
- GTK 3, WebKitGTK 4.1, and libsoup 3 development packages present
- Rust stable available
- Node 22 and npm 10 available at `~/.local/node-v22/bin`

Validated commands:

```bash
PATH="$HOME/.local/node-v22/bin:$PATH" npm run typecheck
PATH="$HOME/.local/node-v22/bin:$PATH" npm run build
PATH="$HOME/.local/node-v22/bin:$PATH" npm run tauri:check --workspace @ddre/desktop
PATH="$HOME/.local/node-v22/bin:$PATH" cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml
PATH="$HOME/.local/node-v22/bin:$PATH" npm run trial:local -- --skip-build
```

The short local trial confirmed:

- API health returned OK at `http://127.0.0.1:4000/health`
- dashboard preview returned HTTP 200 at `http://127.0.0.1:4173`
- the native desktop release process launched in the GNOME Wayland session

The remaining manual GNOME validation is tray behavior: icon visibility, menu reliability, activity switching, settings launch, outbox flush, and fallback usability. Track that against `docs/gnome-tray-validation.md`.

## Local GNOME Runtime Installer

Use the installer when you want a repeatable user-local scaffold from this checkout:

```bash
scripts/install-local-gnome-runtime.sh
```

What it installs:

- desktop binary copied to `~/.local/share/ddre-tim/bin/ddre-desktop`
- desktop launcher at `~/.local/share/applications/ddre-tim.desktop`
- API wrapper at `~/.local/share/ddre-tim/bin/ddre-tim-api`
- dashboard wrapper at `~/.local/share/ddre-tim/bin/ddre-tim-dashboard`
- runtime environment file at `~/.config/ddre-tim/runtime.env`
- systemd user units:
  - `~/.config/systemd/user/ddre-tim-api.service`
  - `~/.config/systemd/user/ddre-tim-dashboard.service`

When the installed desktop app enables `Launch at sign-in` from the tray, it now writes the desktop autostart entry and enables both user services so the API and dashboard restart with the next sign-in as well.

The script detects Node/npm from `PATH` first, then falls back to `~/.local/node-v22/bin`. It also ignores Snap-injected XDG data/config paths so launchers land in the normal user desktop locations.

Useful modes:

```bash
scripts/install-local-gnome-runtime.sh --dry-run --skip-build
scripts/install-local-gnome-runtime.sh --skip-build --start
scripts/install-local-gnome-runtime.sh --skip-build --enable
scripts/install-local-gnome-runtime.sh --skip-build --install-autostart
```

Default runtime binding is local-only:

```dotenv
HOST=127.0.0.1
PORT=4000
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=4173
```

Set `DATABASE_URL` in `~/.config/ddre-tim/runtime.env` only when PostgreSQL is ready for this host. Until then, the API uses the file-backed fallback state under `infra/local-state/`.

## Open Deployment Decisions

- Final office deployment should use PostgreSQL, not the local file-backed fallback.
- Docker is not currently available on the validated GNOME workstation.
- The desktop app currently targets `http://127.0.0.1:4000`, so remote desktop-to-office API configuration still needs a supported runtime setting before home-client deployment.
- The dashboard service currently uses Vite preview. That is acceptable for local runtime validation but should be replaced or explicitly approved before office production use.
- GNOME tray support still needs the manual validation matrix completed before GNOME can be called supported.
