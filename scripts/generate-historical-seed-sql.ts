import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildHistoricalSeedSql,
  defaultHistoricalSeedPath,
  defaultHistoricalSeedSqlPath,
  readImportedHistoricalSeed
} from "./lib/historical-seed-sql.js";

async function main(): Promise<void> {
  const seedPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultHistoricalSeedPath;
  const outputPath = process.argv[3] ? resolve(process.cwd(), process.argv[3]) : defaultHistoricalSeedSqlPath;
  const seed = await readImportedHistoricalSeed(seedPath);
  const { sql, summary } = buildHistoricalSeedSql(seed);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, sql, "utf8");

  console.log(`Wrote SQL seed to ${outputPath}.`);
  console.log(`Departments: ${summary.departmentCount}`);
  console.log(`Activities: ${summary.activityCount}`);
  console.log(`Assignments: ${summary.assignmentCount}`);
  console.log(`Historical records: ${summary.recordCount}`);
  console.log(`Default department: ${summary.defaultDepartmentName}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});