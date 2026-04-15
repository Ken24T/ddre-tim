import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { buildHistoricalSeedSql, readImportedHistoricalSeed } from "./lib/historical-seed-sql.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const sqlDirectoryPath = resolve(repoRoot, "infra/sql");
const seedSqlPath = resolve(repoRoot, "infra/sql/010_seed_ken_boyle_historical.sql");

function readCount(db: ReturnType<typeof newDb>, query: string): number {
  const row = db.public.one<{ count: number | string }>(query);
  return Number(row.count);
}

async function readSchemaSql(): Promise<string> {
  const sqlFileNames = (await readdir(sqlDirectoryPath))
    .filter((fileName) => extname(fileName) === ".sql")
    .filter((fileName) => fileName !== "010_seed_ken_boyle_historical.sql")
    .sort((left, right) => left.localeCompare(right));

  const sqlContents = await Promise.all(
    sqlFileNames.map((fileName) => readFile(resolve(sqlDirectoryPath, fileName), "utf8"))
  );

  return `${sqlContents.join("\n\n")}\n`;
}

async function main(): Promise<void> {
  const [schemaSql, generatedSeed, storedSeedSql] = await Promise.all([
    readSchemaSql(),
    readImportedHistoricalSeed().then((seed) => ({ seed, built: buildHistoricalSeedSql(seed) })),
    readFile(seedSqlPath, "utf8")
  ]);

  if (storedSeedSql.trim() !== generatedSeed.built.sql.trim()) {
    throw new Error("Stored seed SQL is out of date. Run 'npm run db:generate-seed' first.");
  }

  const db = newDb({ autoCreateForeignKeyIndices: true });

  db.public.none(schemaSql);
  db.public.none(storedSeedSql);

  const departmentCount = readCount(db, "select count(*) as count from departments;");
  const userCount = readCount(db, "select count(*) as count from users;");
  const activityCount = readCount(db, "select count(*) as count from activities;");
  const assignmentCount = readCount(db, "select count(*) as count from user_activity_assignments;");
  const historicalCount = readCount(db, "select count(*) as count from historical_tim_daily_records;");
  const settingsSnapshotCount = readCount(db, "select count(*) as count from user_settings_snapshots;");
  const mappedUserCount = readCount(db, "select count(mapped_user_id) as count from historical_tim_daily_records;");
  const mappedDepartmentCount = readCount(db, "select count(mapped_department_id) as count from historical_tim_daily_records;");
  const mappedActivityCount = readCount(db, "select count(mapped_activity_id) as count from historical_tim_daily_records;");

  const defaultDepartmentRow = db.public.one<{ display_name: string; default_department_name: string }>([
    "select users.display_name, departments.name as default_department_name",
    "from users",
    "left join departments on departments.id = users.default_department_id;"
  ].join("\n"));

  if (departmentCount !== generatedSeed.built.summary.departmentCount) {
    throw new Error(`Expected ${generatedSeed.built.summary.departmentCount} departments, found ${departmentCount}.`);
  }

  if (userCount !== 1) {
    throw new Error(`Expected 1 user, found ${userCount}.`);
  }

  if (activityCount !== generatedSeed.built.summary.activityCount) {
    throw new Error(`Expected ${generatedSeed.built.summary.activityCount} activities, found ${activityCount}.`);
  }

  if (assignmentCount !== generatedSeed.built.summary.assignmentCount) {
    throw new Error(`Expected ${generatedSeed.built.summary.assignmentCount} activity assignments, found ${assignmentCount}.`);
  }

  if (historicalCount !== generatedSeed.seed.recordCount) {
    throw new Error(`Expected ${generatedSeed.seed.recordCount} historical records, found ${historicalCount}.`);
  }

  if (settingsSnapshotCount !== 0) {
    throw new Error(`Expected 0 user settings snapshots in the generated seed, found ${settingsSnapshotCount}.`);
  }

  if (mappedUserCount !== historicalCount) {
    throw new Error(`Expected all historical rows to have mapped users, but only ${mappedUserCount} of ${historicalCount} were mapped.`);
  }

  if (mappedDepartmentCount !== historicalCount) {
    throw new Error(`Expected all historical rows to have mapped departments, but only ${mappedDepartmentCount} of ${historicalCount} were mapped.`);
  }

  if (mappedActivityCount !== historicalCount) {
    throw new Error(`Expected all historical rows to have mapped activities, but only ${mappedActivityCount} of ${historicalCount} were mapped.`);
  }

  if (!defaultDepartmentRow.default_department_name) {
    throw new Error(`Expected ${defaultDepartmentRow.display_name} to have a default department.`);
  }

  console.log(`Validated schema and seed in memory.`);
  console.log(`Default department: ${defaultDepartmentRow.default_department_name}`);
  console.log(`Departments: ${departmentCount}`);
  console.log(`Activities: ${activityCount}`);
  console.log(`Assignments: ${assignmentCount}`);
  console.log(`Historical records: ${historicalCount}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});