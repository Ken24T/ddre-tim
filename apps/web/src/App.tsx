import { useEffect, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import {
  createActivityRepositoryEntry,
  fetchActivityCatalog,
  fetchDepartmentCatalog,
  fetchDashboardSnapshot,
  formatHoursLabel,
  formatTimestamp,
  type ActivityCatalogResponse,
  type ActivityRepositoryEntry,
  type ActivityRepositoryMutation,
  type DepartmentCatalogResponse,
  type DashboardQueryValues,
  type DashboardResponse,
  updateActivityRepositoryEntry
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

type ActivityRepositoryState =
  | { phase: "loading" }
  | { phase: "ready"; data: ActivityCatalogResponse }
  | { phase: "error"; message: string };

type DepartmentCatalogState =
  | { phase: "loading" }
  | { phase: "ready"; data: DepartmentCatalogResponse }
  | { phase: "error"; message: string };

type ActivityRepositorySaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "ready"; message: string }
  | { phase: "error"; message: string };

type ActivityRepositoryDraft = {
  name: string;
  color: string;
  departmentId: string;
  isActive: boolean;
};

type DashboardFocus = "all" | "monthly" | "departments" | "activities";

const dashboardFocusOptions: Array<{ id: DashboardFocus; label: string; helper: string; cardCount: number }> = [
  { id: "all", label: "All charts", helper: "Full dashboard", cardCount: 6 },
  { id: "monthly", label: "Hours by User", helper: "Monthly trend", cardCount: 1 },
  { id: "departments", label: "Departments", helper: "Share and split", cardCount: 2 },
  { id: "activities", label: "Activity views", helper: "Mix and by user", cardCount: 2 }
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

interface UserBreakdownPieCard {
  userId: string;
  label: string;
  color: string;
  totalHours: number;
  summary: string;
  slices: BreakdownPieSlice[];
}

const breakdownPiePalette = ["#EEF8FC", "#D9EAF2", "#B9D9EA", "#92D0C8", "#7CB8DD", "#6EA6CF", "#5E8FC3", "#4B79B4"];
const scopeDateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric"
});

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

function parseDateValue(value: string): Date | null {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatScopeDate(value: string): string {
  const parsed = parseDateValue(value);

  return parsed ? scopeDateFormatter.format(parsed) : value;
}

function formatScopeDateRange(from: string, to: string): string {
  if (from === to) {
    return formatScopeDate(from);
  }

  return `${formatScopeDate(from)} to ${formatScopeDate(to)}`;
}

function formatSummaryShare(share: number): string {
  const percentage = share * 100;

  return `${percentage < 10 ? percentage.toFixed(1) : Math.round(percentage)}%`;
}

function formatRepositoryDepartmentLabel(
  departmentId: string | undefined,
  departmentNameById?: Map<string, string>
): string {
  if (!departmentId) {
    return "Shared across departments in the current API slice";
  }

  const departmentName = departmentNameById?.get(departmentId);

  if (departmentName) {
    return departmentName;
  }

  return departmentId
    .replace(/^department-/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sortActivityRepositoryEntries(
  activities: ActivityCatalogResponse["activities"]
): ActivityCatalogResponse["activities"] {
  return [...activities].sort((left, right) => {
    if (left.isActive !== right.isActive) {
      return left.isActive ? -1 : 1;
    }

    if (left.isSystem !== right.isSystem) {
      return left.isSystem ? 1 : -1;
    }

    return left.name.localeCompare(right.name, "en-AU");
  });
}

function createEmptyActivityRepositoryDraft(defaultDepartmentId = ""): ActivityRepositoryDraft {
  return {
    name: "",
    color: "#6EA6CF",
    departmentId: defaultDepartmentId,
    isActive: true
  };
}

function buildActivityRepositoryMutation(draft: ActivityRepositoryDraft): ActivityRepositoryMutation {
  return {
    name: draft.name.trim(),
    color: draft.color.trim() || undefined,
    departmentId: draft.departmentId,
    isActive: draft.isActive
  };
}

function buildSliceSummary(slices: BreakdownPieSlice[]): string {
  const preferredSlices = slices.filter((slice) => slice.label !== "Other");
  const summarySlices = (preferredSlices.length > 0 ? preferredSlices : slices).slice(0, 3);

  if (summarySlices.length === 0) {
    return "No recorded mix in this scope.";
  }

  if (summarySlices.length === 1) {
    return `${summarySlices[0]?.label ?? "Recorded work"} accounts for ${formatSummaryShare(summarySlices[0]?.share ?? 0)} of this user's time.`;
  }

  return summarySlices.map((slice) => `${slice.label} ${formatSummaryShare(slice.share)}`).join(", ");
}

function summarizeSelectedUsers(
  users: DashboardResponse["filters"]["availableUsers"],
  totalUsers: number
): string {
  if (users.length === 0) {
    return "No users selected";
  }

  if (users.length === totalUsers) {
    return `All ${totalUsers} users`;
  }

  if (users.length === 1) {
    return users[0]?.displayName ?? "1 user selected";
  }

  const preview = users.slice(0, 3).map((user) => user.displayName);

  return preview.length === users.length ? preview.join(", ") : `${preview.join(", ")} +${users.length - preview.length} more`;
}

function buildUserBreakdownPieCards(
  breakdownRows: Array<{
    label: string;
    segments: Array<{
      userId: string;
      hours: number;
    }>;
  }>,
  userRows: DashboardResponse["userBreakdown"],
  colorByLabel: Map<string, string>
): UserBreakdownPieCard[] {
  const breakdownsByUser = new Map<string, BreakdownRow[]>();

  for (const breakdownRow of breakdownRows) {
    for (const segment of breakdownRow.segments) {
      const userBreakdowns = breakdownsByUser.get(segment.userId) ?? [];
      userBreakdowns.push({
        label: breakdownRow.label,
        hours: segment.hours
      });
      breakdownsByUser.set(segment.userId, userBreakdowns);
    }
  }

  return userRows
    .map((userRow) => {
      const userBreakdowns = [...(breakdownsByUser.get(userRow.userId) ?? [])].sort((left, right) => {
        return right.hours - left.hours || left.label.localeCompare(right.label, "en-AU");
      });
      const slices = buildBreakdownPieSlices(userBreakdowns, {
        maxRows: 5,
        collapseRemainingLabel: "Other",
        colorByLabel
      });

      return {
        userId: userRow.userId,
        label: userRow.label,
        color: userRow.color,
        totalHours: userRow.hours,
        summary: buildSliceSummary(slices),
        slices
      };
    })
    .filter((card) => card.slices.length > 0);
}

function BreakdownPieLayout({
  slices,
  totalHours,
  ariaLabel,
  activeLabel,
  onSliceToggle
}: {
  slices: BreakdownPieSlice[];
  totalHours: number;
  ariaLabel: string;
  activeLabel?: string;
  onSliceToggle?: (label: string) => void;
}) {
  function getSliceStateClassName(label: string): string {
    if (!activeLabel) {
      return "";
    }

    return activeLabel === label ? " is-active" : " is-dimmed";
  }

  function handleSliceToggle(label: string): void {
    if (!onSliceToggle || label === "Other") {
      return;
    }

    onSliceToggle(label);
  }

  return (
    <div className="pie-chart-layout">
      <div className="pie-chart-wrap">
        <svg className="pie-chart-svg" viewBox="0 0 220 220" role="img" aria-label={ariaLabel}>
          <ellipse className="pie-chart-shadow" cx={pieChartCenterX} cy={pieChartCenterY + pieChartDepth + 56} rx="78" ry="22" />
          <ellipse className="pie-chart-base pie-chart-base-bottom" cx={pieChartCenterX} cy={pieChartCenterY + pieChartDepth} rx={pieChartRadiusX} ry={pieChartRadiusY} />
          {slices.length === 1 ? (
            <>
              <ellipse
                className={`pie-chart-slice pie-chart-slice-bottom${getSliceStateClassName(slices[0]?.label ?? "")}${slices[0]?.label !== "Other" && onSliceToggle ? " is-clickable" : ""}`}
                cx={pieChartCenterX}
                cy={pieChartCenterY + pieChartDepth}
                rx={pieChartRadiusX}
                ry={pieChartRadiusY}
                fill={slices[0]?.sideColor}
                onClick={slices[0]?.label !== "Other" && onSliceToggle ? () => handleSliceToggle(slices[0]?.label ?? "") : undefined}
              />
              <ellipse
                className={`pie-chart-slice pie-chart-slice-top${getSliceStateClassName(slices[0]?.label ?? "")}${slices[0]?.label !== "Other" && onSliceToggle ? " is-clickable" : ""}`}
                cx={pieChartCenterX}
                cy={pieChartCenterY}
                rx={pieChartRadiusX}
                ry={pieChartRadiusY}
                fill={slices[0]?.color}
                onClick={slices[0]?.label !== "Other" && onSliceToggle ? () => handleSliceToggle(slices[0]?.label ?? "") : undefined}
              >
                <title>{`${slices[0]?.label ?? "Department"}: ${formatHoursLabel(slices[0]?.hours ?? 0)}`}</title>
              </ellipse>
            </>
          ) : (
            <>
              <g className="pie-chart-bottom-layer">
                {slices.map((slice) => (
                  <path
                    className={`pie-chart-slice pie-chart-slice-bottom${getSliceStateClassName(slice.label)}${slice.label !== "Other" && onSliceToggle ? " is-clickable" : ""}`}
                    d={slice.bottomPath}
                    fill={slice.sideColor}
                    key={`${slice.label}-bottom`}
                    onClick={slice.label !== "Other" && onSliceToggle ? () => handleSliceToggle(slice.label) : undefined}
                  />
                ))}
              </g>
              <g className="pie-chart-top-layer">
                {slices.map((slice) => (
                  <path
                    className={`pie-chart-slice pie-chart-slice-top${getSliceStateClassName(slice.label)}${slice.label !== "Other" && onSliceToggle ? " is-clickable" : ""}`}
                    d={slice.topPath}
                    fill={slice.color}
                    key={slice.label}
                    onClick={slice.label !== "Other" && onSliceToggle ? () => handleSliceToggle(slice.label) : undefined}
                  >
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
        {slices.map((slice) => {
          const isSelectable = slice.label !== "Other" && Boolean(onSliceToggle);
          const rowClassName = `pie-chart-row${getSliceStateClassName(slice.label)}`;
          const rowContent = (
            <>
              <div className="pie-chart-row-copy">
                <span className="legend-swatch" style={{ background: slice.color }} />
                <strong>{slice.label}</strong>
              </div>
              <div className="pie-chart-row-values">
                <span>{(slice.share * 100).toFixed(1)}%</span>
                <strong>{formatHoursLabel(slice.hours)}</strong>
              </div>
            </>
          );

          return isSelectable ? (
            <button
              aria-pressed={activeLabel === slice.label}
              className={`${rowClassName} pie-chart-row-button`}
              key={slice.label}
              onClick={() => {
                handleSliceToggle(slice.label);
              }}
              type="button"
            >
              {rowContent}
            </button>
          ) : (
            <div className={rowClassName} key={slice.label}>
              {rowContent}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const [healthState, setHealthState] = useState<HealthState>({ phase: "loading" });
  const [dashboardState, setDashboardState] = useState<DashboardState>({ phase: "loading" });
  const [activityRepositoryState, setActivityRepositoryState] = useState<ActivityRepositoryState>({ phase: "loading" });
  const [departmentCatalogState, setDepartmentCatalogState] = useState<DepartmentCatalogState>({ phase: "loading" });
  const [activityRepositoryRequestKey, setActivityRepositoryRequestKey] = useState(0);
  const [isActivityRepositoryOpen, setIsActivityRepositoryOpen] = useState(false);
  const [editingActivityRepositoryId, setEditingActivityRepositoryId] = useState<string | null>(null);
  const [activityRepositoryDraft, setActivityRepositoryDraft] = useState<ActivityRepositoryDraft>(createEmptyActivityRepositoryDraft());
  const [activityRepositorySaveState, setActivityRepositorySaveState] = useState<ActivityRepositorySaveState>({ phase: "idle" });
  const [draftFilters, setDraftFilters] = useState<FilterFormState>(createEmptyFilters());
  const [appliedFilters, setAppliedFilters] = useState<DashboardQueryValues>({});
  const [dashboardFocus, setDashboardFocus] = useState<DashboardFocus>("all");
  const [userSearch, setUserSearch] = useState("");
  const [activeDepartmentLabel, setActiveDepartmentLabel] = useState<string | undefined>(undefined);
  const [activeActivityLabel, setActiveActivityLabel] = useState<string | undefined>(undefined);

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

    setActivityRepositoryState({ phase: "loading" });

    async function loadActivityRepository(): Promise<void> {
      try {
        const payload = await fetchActivityCatalog();

        if (!cancelled) {
          setActivityRepositoryState({ phase: "ready", data: payload });
        }
      } catch (error) {
        if (!cancelled) {
          setActivityRepositoryState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadActivityRepository();

    return () => {
      cancelled = true;
    };
  }, [activityRepositoryRequestKey]);

  useEffect(() => {
    let cancelled = false;

    setDepartmentCatalogState({ phase: "loading" });

    async function loadDepartmentCatalog(): Promise<void> {
      try {
        const payload = await fetchDepartmentCatalog();

        if (!cancelled) {
          setDepartmentCatalogState({ phase: "ready", data: payload });
        }
      } catch (error) {
        if (!cancelled) {
          setDepartmentCatalogState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    void loadDepartmentCatalog();

    return () => {
      cancelled = true;
    };
  }, [activityRepositoryRequestKey]);

  useEffect(() => {
    if (departmentCatalogState.phase !== "ready") {
      return;
    }

    const [firstDepartment] = departmentCatalogState.data.departments;

    if (!firstDepartment) {
      return;
    }

    setActivityRepositoryDraft((current) => {
      if (current.departmentId) {
        return current;
      }

      return {
        ...current,
        departmentId: firstDepartment.id
      };
    });
  }, [departmentCatalogState]);

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
    setUserSearch("");
    setActiveDepartmentLabel(undefined);
    setActiveActivityLabel(undefined);
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

  function toggleDepartmentHighlight(label: string): void {
    setActiveDepartmentLabel((current) => (current === label ? undefined : label));
  }

  function toggleActivityHighlight(label: string): void {
    setActiveActivityLabel((current) => (current === label ? undefined : label));
  }

  function getDefaultActivityRepositoryDepartmentId(): string {
    if (departmentCatalogState.phase !== "ready") {
      return "";
    }

    return departmentCatalogState.data.departments[0]?.id ?? "";
  }

  function resetActivityRepositoryEditor(): void {
    setEditingActivityRepositoryId(null);
    setActivityRepositorySaveState({ phase: "idle" });
    setActivityRepositoryDraft(createEmptyActivityRepositoryDraft(getDefaultActivityRepositoryDepartmentId()));
  }

  function handleEditActivityRepository(activity: ActivityRepositoryEntry): void {
    setEditingActivityRepositoryId(activity.id);
    setActivityRepositorySaveState({ phase: "idle" });
    setIsActivityRepositoryOpen(true);
    setActivityRepositoryDraft({
      name: activity.name,
      color: activity.color ?? "#6EA6CF",
      departmentId: activity.departmentId ?? getDefaultActivityRepositoryDepartmentId(),
      isActive: activity.isActive
    });
  }

  async function handleActivityRepositorySubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    setActivityRepositorySaveState({ phase: "saving" });

    try {
      const payload = buildActivityRepositoryMutation(activityRepositoryDraft);
      const savedActivity = editingActivityRepositoryId
        ? await updateActivityRepositoryEntry(editingActivityRepositoryId, payload)
        : await createActivityRepositoryEntry(payload);

      setActivityRepositorySaveState({
        phase: "ready",
        message: editingActivityRepositoryId
          ? `${savedActivity.name} updated in the shared repository.`
          : `${savedActivity.name} added to the shared repository.`
      });
      setActivityRepositoryRequestKey((current) => current + 1);
      setEditingActivityRepositoryId(null);
      setActivityRepositoryDraft(createEmptyActivityRepositoryDraft(payload.departmentId));
    } catch (error) {
      setActivityRepositorySaveState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const dashboardData = dashboardState.phase === "ready" || dashboardState.phase === "refreshing" ? dashboardState.data : null;
  const departmentCatalogData = departmentCatalogState.phase === "ready" ? departmentCatalogState.data : null;
  const availableRepositoryDepartments = departmentCatalogData?.departments.filter((department) => department.isActive) ?? [];
  const repositoryDepartmentNameById = new Map((departmentCatalogData?.departments ?? []).map((department) => [department.id, department.name]));
  const allUsers = dashboardData?.filters.availableUsers ?? [];
  const selectedUsers = allUsers.filter((user) => user.isSelected);
  const normalizedUserSearch = userSearch.trim().toLowerCase();
  const visibleUsers = allUsers.filter((user) => user.displayName.toLowerCase().includes(normalizedUserSearch));
  const selectedUserSummary = dashboardData ? summarizeSelectedUsers(selectedUsers, allUsers.length) : "Loading users";
  const selectedUserMeta = dashboardData ? `${selectedUsers.length} of ${allUsers.length} selected` : "Waiting for user scope";
  const summaryCards = dashboardData ? buildSummaryCards(dashboardData) : [];
  const monthlyChartMax = dashboardData ? Math.max(...dashboardData.monthlyUserTotals.map((month) => month.totalHours), 0) : 0;
  const userRows = dashboardData?.userBreakdown ?? [];
  const departmentBreakdownRows = dashboardData?.departmentBreakdown ?? [];
  const departmentColorByLabel = buildBreakdownColorMap(departmentBreakdownRows, ["Other"]);
  const departmentPieSlices = buildBreakdownPieSlices(departmentBreakdownRows, {
    maxRows: 5,
    collapseRemainingLabel: "Other",
    colorByLabel: departmentColorByLabel
  });
  const departmentPieTotal = departmentPieSlices.reduce((total, slice) => total + slice.hours, 0);
  const activityBreakdownRows = dashboardData?.activityBreakdown ?? [];
  const departmentUserRows = dashboardData?.departmentUserBreakdown ?? [];
  const departmentUserPieCards = buildUserBreakdownPieCards(departmentUserRows, userRows, departmentColorByLabel);
  const activityColorByLabel = buildBreakdownColorMap(activityBreakdownRows, ["Other"]);
  const activityPieSlices = buildBreakdownPieSlices(activityBreakdownRows, {
    maxRows: 7,
    collapseRemainingLabel: "Other",
    colorByLabel: activityColorByLabel
  });
  const activityPieTotal = activityPieSlices.reduce((total, slice) => total + slice.hours, 0);
  const activityUserPieCards = buildUserBreakdownPieCards(dashboardData?.activityUserBreakdown ?? [], userRows, activityColorByLabel);
  const activeDepartmentHighlight =
    activeDepartmentLabel && departmentBreakdownRows.some((row) => row.label === activeDepartmentLabel) ? activeDepartmentLabel : undefined;
  const activeActivityHighlight =
    activeActivityLabel && activityBreakdownRows.some((row) => row.label === activeActivityLabel) ? activeActivityLabel : undefined;
  const dateWindowLabel = dashboardData
    ? formatScopeDateRange(dashboardData.filters.selectedFrom, dashboardData.filters.selectedTo)
    : "Waiting for dates";
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
  const activityRepositoryData = activityRepositoryState.phase === "ready" ? activityRepositoryState.data : null;
  const activityRepositoryEntries = activityRepositoryData ? sortActivityRepositoryEntries(activityRepositoryData.activities) : [];
  const editingActivityRepository = editingActivityRepositoryId
    ? activityRepositoryEntries.find((activity) => activity.id === editingActivityRepositoryId)
    : undefined;
  const sharedRepositoryCount = activityRepositoryEntries.filter((activity) => !activity.isSystem).length;
  const trayReadyRepositoryCount = activityRepositoryEntries.filter((activity) => activity.kind === "timed" && activity.isActive).length;
  const activityRepositoryTone =
    activityRepositoryState.phase === "ready" ? "online" : activityRepositoryState.phase === "error" ? "offline" : "checking";
  const activityRepositoryMeta =
    activityRepositoryState.phase === "ready"
      ? `${sharedRepositoryCount} shared activities`
      : activityRepositoryState.phase === "error"
        ? "Repository unavailable"
        : "Loading shared catalog";
  const showMonthlyCharts = dashboardFocus === "all" || dashboardFocus === "monthly";
  const showDepartmentCharts = dashboardFocus === "all" || dashboardFocus === "departments";
  const showActivityCharts = dashboardFocus === "all" || dashboardFocus === "activities";

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-bar">
          <p className="eyebrow">Time in Motion</p>

          <div className="hero-actions">
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

            <button
              aria-controls="activity-repository-panel"
              aria-expanded={isActivityRepositoryOpen}
              className={`activity-repository-trigger is-${activityRepositoryTone}${isActivityRepositoryOpen ? " is-active" : ""}`}
              onClick={() => {
                setIsActivityRepositoryOpen((current) => !current);
              }}
              type="button"
            >
              <span className="activity-repository-indicator" aria-hidden="true" />
              <span className="api-status-copy">
                <strong>Activity Repository</strong>
                <small>{activityRepositoryMeta}</small>
              </span>
            </button>
          </div>
        </div>

        <h1>DDRE TiM Dashboard</h1>
        <p className="lead">
          This dashboard turns day-to-day activity data into a practical view of how work is moving across the business.
          Used thoughtfully, it can be an invaluable resource for healthier planning, clearer conversations, and steady
          company development without losing sight of the people behind the work.
        </p>

        {isActivityRepositoryOpen ? (
          <div className="panel activity-repository-panel" id="activity-repository-panel">
            <div className="activity-repository-header">
              <div className="activity-repository-copy">
                <p className="panel-label">Admin catalog</p>
                <h2>Shared activities for the tray</h2>
                <p>
                  This is the dashboard entry point for the shared activity catalog the tray should read first. Users
                  should only add a custom activity when the shared list does not fit, and admins can later promote
                  repeated custom work back into the repository.
                </p>
              </div>

              <div className="activity-repository-summary">
                <div className="activity-repository-stat">
                  <span>Shared catalog</span>
                  <strong>{activityRepositoryState.phase === "ready" ? `${sharedRepositoryCount}` : "..."}</strong>
                  <small>Repository activities currently exposed by the API.</small>
                </div>

                <div className="activity-repository-stat">
                  <span>Tray-ready</span>
                  <strong>{activityRepositoryState.phase === "ready" ? `${trayReadyRepositoryCount}` : "..."}</strong>
                  <small>Active timed activities that can flow straight into the tray menu.</small>
                </div>

                <div className="activity-repository-stat">
                  <span>Custom fallback</span>
                  <strong>Planned</strong>
                  <small>User-specific activities should stay local until an admin promotes them.</small>
                </div>
              </div>
            </div>

            <div className="activity-repository-grid">
              <article className="activity-repository-section">
                <div className="activity-repository-section-header">
                  <div>
                    <p className="panel-label">Current API catalog</p>
                    <h3>Shared repository entries</h3>
                  </div>
                  <div className="activity-repository-section-actions">
                    {activityRepositoryData ? <small>Refreshed {formatTimestamp(activityRepositoryData.refreshedAt)}</small> : null}
                    <button className="button" onClick={resetActivityRepositoryEditor} type="button">
                      New activity
                    </button>
                  </div>
                </div>

                {activityRepositoryState.phase === "loading" ? <p>Loading the shared activity repository from the API.</p> : null}

                {activityRepositoryState.phase === "error" ? (
                  <div className="activity-repository-empty-state">
                    <p>{activityRepositoryState.message}</p>
                    <button
                      className="button button-primary"
                      onClick={() => {
                        setActivityRepositoryRequestKey((current) => current + 1);
                      }}
                      type="button"
                    >
                      Retry repository load
                    </button>
                  </div>
                ) : null}

                {activityRepositoryState.phase === "ready" ? (
                  activityRepositoryEntries.length > 0 ? (
                    <div className="repository-activity-list">
                      {activityRepositoryEntries.map((activity) => (
                        <div className={`repository-activity-card${!activity.isActive ? " is-inactive" : ""}`} key={activity.id}>
                          <div className="repository-activity-header">
                            <div className="repository-activity-title">
                              <span className="repository-activity-swatch" style={{ background: activity.color ?? "#D9EAF2" }} />
                              <div>
                                <strong>{activity.name}</strong>
                                <small>{formatRepositoryDepartmentLabel(activity.departmentId, repositoryDepartmentNameById)}</small>
                              </div>
                            </div>
                            <span className="repository-activity-chip">{activity.isSystem ? "System" : activity.isActive ? "Active" : "Inactive"}</span>
                          </div>
                          <p>
                            {activity.kind === "timed"
                              ? "Shared timed activity ready for tray selection."
                              : "System-managed activity reserved by the platform."}
                          </p>
                          <div className="repository-activity-actions">
                            <button
                              className="button repository-activity-edit-button"
                              disabled={activity.isSystem}
                              onClick={() => {
                                handleEditActivityRepository(activity);
                              }}
                              type="button"
                            >
                              Edit entry
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No shared activities are available from the API yet.</p>
                  )
                ) : null}
              </article>

              <article className="activity-repository-section">
                <div className="activity-repository-section-header">
                  <div>
                    <p className="panel-label">Repository editor</p>
                    <h3>{editingActivityRepository ? `Edit ${editingActivityRepository.name}` : "Add shared activity"}</h3>
                  </div>
                  {editingActivityRepository ? (
                    <button className="button" onClick={resetActivityRepositoryEditor} type="button">
                      Create new
                    </button>
                  ) : null}
                </div>

                <p>
                  Admins manage the shared catalog here so the tray can stay menu-first and lightweight. When this list is missing
                  something, users can add a custom activity later without taking ownership of the shared repository.
                </p>

                {departmentCatalogState.phase === "loading" ? <p>Loading department options for the repository editor.</p> : null}

                {departmentCatalogState.phase === "error" ? (
                  <div className="activity-repository-empty-state">
                    <p>{departmentCatalogState.message}</p>
                    <button
                      className="button button-primary"
                      onClick={() => {
                        setActivityRepositoryRequestKey((current) => current + 1);
                      }}
                      type="button"
                    >
                      Retry department load
                    </button>
                  </div>
                ) : null}

                {departmentCatalogState.phase === "ready" ? (
                  <form className="repository-editor-form" onSubmit={handleActivityRepositorySubmit}>
                    <label>
                      <span>Activity name</span>
                      <input
                        maxLength={100}
                        onChange={(event) => {
                          setActivityRepositoryDraft((current) => ({
                            ...current,
                            name: event.target.value
                          }));
                        }}
                        placeholder="Enter a shared tray activity"
                        type="text"
                        value={activityRepositoryDraft.name}
                      />
                    </label>

                    <label>
                      <span>Department</span>
                      <select
                        onChange={(event) => {
                          setActivityRepositoryDraft((current) => ({
                            ...current,
                            departmentId: event.target.value
                          }));
                        }}
                        value={activityRepositoryDraft.departmentId}
                      >
                        <option value="" disabled>
                          Select department
                        </option>
                        {availableRepositoryDepartments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="repository-editor-color-field">
                      <span>Colour</span>
                      <div className="repository-editor-color-control">
                        <span className="repository-activity-swatch repository-activity-swatch-large" style={{ background: activityRepositoryDraft.color || "#D9EAF2" }} />
                        <input
                          maxLength={7}
                          onChange={(event) => {
                            setActivityRepositoryDraft((current) => ({
                              ...current,
                              color: event.target.value.toUpperCase()
                            }));
                          }}
                          pattern="^#[0-9A-Fa-f]{6}$"
                          placeholder="#6EA6CF"
                          type="text"
                          value={activityRepositoryDraft.color}
                        />
                      </div>
                    </label>

                    <label className="repository-editor-toggle">
                      <span>Status</span>
                      <div className="repository-editor-toggle-row">
                        <input
                          checked={activityRepositoryDraft.isActive}
                          onChange={(event) => {
                            setActivityRepositoryDraft((current) => ({
                              ...current,
                              isActive: event.target.checked
                            }));
                          }}
                          type="checkbox"
                        />
                        <small>
                          {activityRepositoryDraft.isActive
                            ? "Active in new tray selections"
                            : "Inactive for new tray selections but kept for history and review"}
                        </small>
                      </div>
                    </label>

                    <div className="repository-editor-actions">
                      <button
                        className="button button-primary"
                        disabled={
                          activityRepositorySaveState.phase === "saving" ||
                          activityRepositoryDraft.name.trim().length === 0 ||
                          activityRepositoryDraft.departmentId.length === 0
                        }
                        type="submit"
                      >
                        {activityRepositorySaveState.phase === "saving"
                          ? editingActivityRepository
                            ? "Saving changes..."
                            : "Adding activity..."
                          : editingActivityRepository
                            ? "Save changes"
                            : "Add to repository"}
                      </button>

                      {editingActivityRepository ? (
                        <button className="button" onClick={resetActivityRepositoryEditor} type="button">
                          Cancel editing
                        </button>
                      ) : null}
                    </div>
                  </form>
                ) : null}

                {activityRepositorySaveState.phase === "ready" ? (
                  <p className="activity-repository-feedback is-ready">{activityRepositorySaveState.message}</p>
                ) : null}

                {activityRepositorySaveState.phase === "error" ? (
                  <p className="activity-repository-feedback is-error">{activityRepositorySaveState.message}</p>
                ) : null}

                <div className="activity-repository-guidance">
                  <div className="activity-repository-guidance-item">
                    <strong>Shared repository</strong>
                    <p>Admins maintain the common activity library here so tray users can start recording work without building a taxonomy from scratch.</p>
                  </div>

                  <div className="activity-repository-guidance-item">
                    <strong>User custom activity</strong>
                    <p>If the shared list misses something, the tray should let the user add a custom activity without editing the admin repository directly.</p>
                  </div>

                  <div className="activity-repository-guidance-item">
                    <strong>Promotion path</strong>
                    <p>Frequently reused custom activities can be reviewed here and promoted into the shared catalog for future tray sessions.</p>
                  </div>

                  <div className="activity-repository-guidance-item">
                    <strong>Tray result</strong>
                    <p>The tray menu should merge the shared repository, any user custom activities, and the system-managed Not Timed state into one menu-first capture flow.</p>
                  </div>
                </div>
              </article>
            </div>
          </div>
        ) : null}
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
              <div className="user-filter-selection">
                <strong>{dashboardData ? selectedUserMeta : "Loading users"}</strong>
                <small>{dashboardData?.scopeLabel ?? "Waiting for user scope"}</small>
              </div>
            </div>

            <p className="user-filter-summary">{selectedUserSummary}</p>

            <div className="user-filter-toolbar">
              <label className="user-filter-search">
                <span>Find user</span>
                <input
                  disabled={dashboardBusy && !dashboardData}
                  onChange={(event) => {
                    setUserSearch(event.target.value);
                  }}
                  placeholder="Search by name"
                  type="search"
                  value={userSearch}
                />
              </label>
              <small>
                {normalizedUserSearch
                  ? `${visibleUsers.length} match${visibleUsers.length === 1 ? "" : "es"}`
                  : `${allUsers.length} available`}
              </small>
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

              {visibleUsers.map((user) => (
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

            {dashboardData && visibleUsers.length === 0 ? <p className="user-filter-empty">No users match this search.</p> : null}

            <p className="user-filter-hint">Selected users stay in scope while you search, adjust department, or change the date window.</p>
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
        <section className="panel scope-panel">
          <div className="scope-copy">
            <p className="panel-label">Current scope</p>
            <p className="scope-hint">The charts below reflect this exact reporting window, including the latest imported read model.</p>
          </div>

          <div className="scope-chip-list">
            <div className="scope-chip">
              <span>Users</span>
              <strong>{selectedUserSummary}</strong>
              <small>{selectedUserMeta}</small>
            </div>

            <div className="scope-chip">
              <span>Department</span>
              <strong>{dashboardData.filters.selectedDepartment ?? "All departments"}</strong>
              <small>{dashboardData.stats.departmentCount} departments represented</small>
            </div>

            <div className="scope-chip">
              <span>Date window</span>
              <strong>{dateWindowLabel}</strong>
              <small>{formatHoursLabel(dashboardData.stats.totalHours)} imported hours in view</small>
            </div>

            <div className="scope-chip">
              <span>Data freshness</span>
              <strong>{formatTimestamp(dashboardData.importedAt)}</strong>
              <small>Latest dashboard import</small>
            </div>
          </div>
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
                <h2>Hours by User</h2>
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

            {showDepartmentCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Department chart</p>
                <h2>Where the selected users are spending time</h2>
                <div className="chart-toolbar">
                  <p className="chart-toolbar-copy">
                    {activeDepartmentHighlight
                      ? `Highlighting ${activeDepartmentHighlight} across both department charts.`
                      : "Select a named department slice or legend row to highlight it across both department charts."}
                  </p>
                  {activeDepartmentHighlight ? (
                    <button
                      className="button"
                      onClick={() => {
                        setActiveDepartmentLabel(undefined);
                      }}
                      type="button"
                    >
                      Clear highlight
                    </button>
                  ) : null}
                </div>
                {departmentPieSlices.length > 0 ? (
                  <BreakdownPieLayout
                    activeLabel={activeDepartmentHighlight}
                    ariaLabel="Department share 3D pie chart"
                    onSliceToggle={toggleDepartmentHighlight}
                    slices={departmentPieSlices}
                    totalHours={departmentPieTotal}
                  />
                ) : (
                  <p>No department data in the current filter window.</p>
                )}
              </article>
            ) : null}

            {showDepartmentCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Department by user</p>
                <h2>How each selected user divides time across departments</h2>
                {departmentUserPieCards.length > 0 ? (
                  <>
                    <div className="user-activity-pies" role="img" aria-label="Department breakdown pie charts by user">
                      {departmentUserPieCards.map((card) => (
                        <div
                          className={`user-activity-card${activeDepartmentHighlight && !card.slices.some((slice) => slice.label === activeDepartmentHighlight) ? " is-dimmed" : ""}`}
                          key={card.userId}
                        >
                          <div className="user-activity-card-header">
                            <div className="user-activity-card-title">
                              <span className="legend-swatch" style={{ background: card.color }} />
                              <strong>{card.label}</strong>
                            </div>
                            <span className="user-activity-card-total">{formatHoursLabel(card.totalHours)}</span>
                          </div>

                          <p className="user-activity-card-summary">Top mix: {card.summary}</p>

                          <BreakdownPieLayout
                            activeLabel={activeDepartmentHighlight}
                            onSliceToggle={toggleDepartmentHighlight}
                            slices={card.slices}
                            totalHours={card.totalHours}
                            ariaLabel={`${card.label} department breakdown pie chart`}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p>No department-by-user data is available for the current filter window.</p>
                )}
              </article>
            ) : null}

            {showActivityCharts ? (
              <article className="panel panel-span-2 chart-panel">
                <p className="panel-label">Activity overview</p>
                <h2>Overall Activity Mix</h2>
                <div className="chart-toolbar">
                  <p className="chart-toolbar-copy">
                    {activeActivityHighlight
                      ? `Highlighting ${activeActivityHighlight} across both activity charts.`
                      : "Select a named activity slice or legend row to highlight it across both activity charts."}
                  </p>
                  {activeActivityHighlight ? (
                    <button
                      className="button"
                      onClick={() => {
                        setActiveActivityLabel(undefined);
                      }}
                      type="button"
                    >
                      Clear highlight
                    </button>
                  ) : null}
                </div>
                {activityPieSlices.length > 0 ? (
                  <BreakdownPieLayout
                    activeLabel={activeActivityHighlight}
                    ariaLabel="Activity breakdown 3D pie chart"
                    onSliceToggle={toggleActivityHighlight}
                    slices={activityPieSlices}
                    totalHours={activityPieTotal}
                  />
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
                        <div
                          className={`user-activity-card${activeActivityHighlight && !card.slices.some((slice) => slice.label === activeActivityHighlight) ? " is-dimmed" : ""}`}
                          key={card.userId}
                        >
                          <div className="user-activity-card-header">
                            <div className="user-activity-card-title">
                              <span className="legend-swatch" style={{ background: card.color }} />
                              <strong>{card.label}</strong>
                            </div>
                            <span className="user-activity-card-total">{formatHoursLabel(card.totalHours)}</span>
                          </div>

                          <p className="user-activity-card-summary">Top mix: {card.summary}</p>

                          <BreakdownPieLayout
                            activeLabel={activeActivityHighlight}
                            onSliceToggle={toggleActivityHighlight}
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