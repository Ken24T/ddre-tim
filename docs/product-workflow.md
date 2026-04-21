# Product Workflow

## User Session

1. The user logs into their workstation and the tray app auto-starts inside their desktop session.
2. On first run, the app requires settings completion before timed capture begins.
3. The user enters their name, which is stored in Propercase.
4. The user selects a default department for new work.
5. The tray should load a shared admin-managed activity repository first so users can begin capture without building a taxonomy from scratch.
6. If the shared repository does not fit the work being done, the user can add a custom timed activity as a fallback without directly changing the shared repository.
7. Reused custom activities can later be promoted into the shared repository by an admin through the dashboard.
8. The system always includes a non-removable `Not Timed` activity for non-billable or uncategorized time.

## Activity Capture

1. Choosing a timed activity starts that activity immediately.
2. Choosing another timed activity ends the previous timed activity and starts the new one at the same selection timestamp.
3. Choosing `Not Timed` ends the previous timed activity and moves the user into a non-timed state.
4. The backend derives session totals, durations, and charts from the event history rather than trusting client-authored durations.

## Manager Dashboard

1. Managers open the TiM dashboard in a browser.
2. Dashboard views are filtered server-side according to the manager's scope and role.
3. Property-management leaders see only their property-management staff.
4. Broader roles such as business owner can be granted access to all users and departments.
5. Admin-capable dashboard users manage the shared activity repository so the tray stays menu-first and consistent across users.
6. Shared repository entries can be created, updated, activated, or retired without removing historical activity records.