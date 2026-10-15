import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = path.join(import.meta.dirname, "__tests__");
const tests = fs.readdirSync(directory).filter((name) => name.endsWith(".test.mjs"))
  .sort().map((name) => path.join(directory, name));
const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit", shell: false,
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
}
process.exitCode = result.status ?? 1;
