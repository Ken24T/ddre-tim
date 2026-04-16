import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

type WorksheetRow = Array<string | number | Date | null>;

interface ImportedHistoricalRecord {
  id: string;
  workDate: string;
  employeeName: string;
  departmentName: string;
  activityName: string;
  hours: number;
  sourceRowNumber: number;
}

interface ImportedHistoricalSeed {
  sourceFile: string;
  sheetName: string;
  employeeFilter: string;
  importedAt: string;
  recordCount: number;
  departments: string[];
  activities: string[];
  records: ImportedHistoricalRecord[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const defaultWorkbookPath = "/home/ken/Downloads/TiM Metrics.xlsx";
const defaultOutputPath = resolve(repoRoot, "infra/seeds/ken-boyle-historical-tim-records.json");
const targetEmployee = "Ken Boyle";
const targetSheetName = "TiM Records";

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeComparisonValue(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("en-AU");
}

function normalizeHeaderValue(value: string | number | Date | null): string {
  return normalizeWhitespace(String(value ?? "")).toLocaleLowerCase("en-AU");
}

function getRequiredColumnIndex(headerIndex: Map<string, number>, columnName: string): number {
  const index = headerIndex.get(columnName.toLocaleLowerCase("en-AU"));

  if (index === undefined) {
    throw new Error(`Workbook is missing the required '${columnName}' column.`);
  }

  return index;
}

function formatDateValue(year: number, month: number, day: number): string {
  return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

function parseAustralianDate(value: string | number | Date | null, rowNumber: number): string {
  if (value instanceof Date) {
    return formatDateValue(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === "number") {
    const parsedDate = XLSX.SSF.parse_date_code(value);

    if (!parsedDate) {
      throw new Error(`Row ${rowNumber}: could not parse Excel date serial '${value}'.`);
    }

    return formatDateValue(parsedDate.y, parsedDate.m, parsedDate.d);
  }

  const normalizedValue = normalizeWhitespace(String(value ?? ""));

  if (!normalizedValue) {
    throw new Error(`Row ${rowNumber}: Date is required.`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return normalizedValue;
  }

  const numericMatch = normalizedValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);

  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]);
    const year = Number(numericMatch[3].length === 2 ? `20${numericMatch[3]}` : numericMatch[3]);

    return formatDateValue(year, month, day);
  }

  const parsedTimestamp = Date.parse(normalizedValue);

  if (!Number.isNaN(parsedTimestamp)) {
    const parsedDate = new Date(parsedTimestamp);

    return formatDateValue(parsedDate.getFullYear(), parsedDate.getMonth() + 1, parsedDate.getDate());
  }

  throw new Error(`Row ${rowNumber}: unsupported date value '${normalizedValue}'.`);
}

function parseHours(value: string | number | Date | null, rowNumber: number): number {
  if (typeof value === "number") {
    return Number(value.toFixed(2));
  }

  const normalizedValue = normalizeWhitespace(String(value ?? ""));
  const parsedNumber = Number(normalizedValue.replace(/,/g, ""));

  if (!normalizedValue || Number.isNaN(parsedNumber)) {
    throw new Error(`Row ${rowNumber}: Hours must be numeric.`);
  }

  return Number(parsedNumber.toFixed(2));
}

function addHours(left: number, right: number): number {
  return Number((left + right).toFixed(2));
}

function buildStableId(record: Omit<ImportedHistoricalRecord, "id">): string {
  const sourceKey = [
    record.workDate,
    normalizeComparisonValue(record.employeeName),
    normalizeComparisonValue(record.departmentName),
    normalizeComparisonValue(record.activityName),
    record.hours.toFixed(2)
  ].join("|");

  return `historical-${createHash("sha256").update(sourceKey).digest("hex").slice(0, 16)}`;
}

function isBlankRow(row: WorksheetRow): boolean {
  return row.every((value) => normalizeWhitespace(String(value ?? "")) === "");
}

async function main(): Promise<void> {
  const workbookPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultWorkbookPath;
  const outputPath = process.argv[3] ? resolve(process.cwd(), process.argv[3]) : defaultOutputPath;
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });
  const worksheet = workbook.Sheets[targetSheetName];

  if (!worksheet) {
    throw new Error(`Workbook does not contain the '${targetSheetName}' sheet.`);
  }

  const rawRows = XLSX.utils.sheet_to_json<WorksheetRow>(worksheet, {
    header: 1,
    raw: true,
    defval: null
  });

  const [headerRow, ...dataRows] = rawRows;

  if (!headerRow) {
    throw new Error("Workbook sheet is empty.");
  }

  const headerIndex = new Map(headerRow.map((value, index) => [normalizeHeaderValue(value), index]));
  const dateColumn = getRequiredColumnIndex(headerIndex, "Date");
  const employeeColumn = getRequiredColumnIndex(headerIndex, "Employee");
  const departmentColumn = getRequiredColumnIndex(headerIndex, "Department");
  const activityColumn = getRequiredColumnIndex(headerIndex, "Activity");
  const hoursColumn = getRequiredColumnIndex(headerIndex, "Hours");
  const aggregatedRecords = new Map<string, Omit<ImportedHistoricalRecord, "id">>();

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;

    if (isBlankRow(row)) {
      return;
    }

    const employeeName = normalizeWhitespace(String(row[employeeColumn] ?? ""));

    if (normalizeComparisonValue(employeeName) !== normalizeComparisonValue(targetEmployee)) {
      return;
    }

    const recordWithoutId = {
      workDate: parseAustralianDate(row[dateColumn], rowNumber),
      employeeName,
      departmentName: normalizeWhitespace(String(row[departmentColumn] ?? "")),
      activityName: normalizeWhitespace(String(row[activityColumn] ?? "")),
      hours: parseHours(row[hoursColumn], rowNumber),
      sourceRowNumber: rowNumber
    };

    if (!recordWithoutId.departmentName) {
      throw new Error(`Row ${rowNumber}: Department is required.`);
    }

    if (!recordWithoutId.activityName) {
      throw new Error(`Row ${rowNumber}: Activity is required.`);
    }

    const duplicateKey = [
      recordWithoutId.workDate,
      normalizeComparisonValue(recordWithoutId.employeeName),
      normalizeComparisonValue(recordWithoutId.departmentName),
      normalizeComparisonValue(recordWithoutId.activityName)
    ].join("|");

    const existingRecord = aggregatedRecords.get(duplicateKey);

    if (existingRecord) {
      existingRecord.hours = addHours(existingRecord.hours, recordWithoutId.hours);
      existingRecord.sourceRowNumber = Math.min(existingRecord.sourceRowNumber, recordWithoutId.sourceRowNumber);
      return;
    }

    aggregatedRecords.set(duplicateKey, recordWithoutId);
  });

  const importedRecords = Array.from(aggregatedRecords.values(), (record) => ({
    id: buildStableId(record),
    ...record
  }));

  importedRecords.sort((left, right) => {
    return left.workDate.localeCompare(right.workDate)
      || left.departmentName.localeCompare(right.departmentName)
      || left.activityName.localeCompare(right.activityName)
      || left.sourceRowNumber - right.sourceRowNumber;
  });

  const payload: ImportedHistoricalSeed = {
    sourceFile: basename(workbookPath),
    sheetName: targetSheetName,
    employeeFilter: targetEmployee,
    importedAt: new Date().toISOString(),
    recordCount: importedRecords.length,
    departments: Array.from(new Set(importedRecords.map((record) => record.departmentName))).sort((left, right) => left.localeCompare(right)),
    activities: Array.from(new Set(importedRecords.map((record) => record.activityName))).sort((left, right) => left.localeCompare(right)),
    records: importedRecords
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Imported ${payload.recordCount} records for ${payload.employeeFilter}.`);
  console.log(`Wrote seed data to ${outputPath}.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});