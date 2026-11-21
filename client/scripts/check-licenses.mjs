// Dependency licence check: every installed package (all workspace projects, dev tools included) must carry a
// permissive licence. Reads pnpm's own licence report, which covers the whole lockfile; tools that walk node_modules
// miss most of pnpm's isolated layout.
import { execFileSync } from "node:child_process";

const allowed = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "MPL-2.0",
  "CC-BY-3.0",
  "OFL-1.1",
  "Unlicense",
  "EPL-2.0",
]);

// Reviewed one by one: name@version.
const exceptions = new Set(["fetch-cookie@2.2.0", "argparse@3.0.4"]);

// Packages whose package.json has no licence field, checked by reading their licence file: name@version -> licence.
const declared = new Map([["khroma@2.1.0", "MIT"]]);

/** An SPDX expression passes if any OR branch has only allowed licences (mixed AND/OR without parentheses is read strictly). */
function isAllowed(expression) {
  const ids = (s) =>
    s
      .replace(/[()]/g, " ")
      .split(/\s+(?:AND|OR)\s+|\s+/)
      .filter(Boolean);
  const plain = expression.replace(/^\((.*)\)$/, "$1");
  if (!plain.includes("(") && plain.includes(" OR ") && !plain.includes(" AND ")) {
    return ids(plain).some((id) => allowed.has(id));
  }
  return ids(plain).every((id) => allowed.has(id));
}

const report = JSON.parse(
  execFileSync("pnpm", ["-r", "licenses", "list", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
);

const counts = new Map();
const failures = [];
for (const [licence, packages] of Object.entries(report)) {
  for (const pkg of packages) {
    for (const version of pkg.versions) {
      const id = `${pkg.name}@${version}`;
      if (exceptions.has(id)) continue;
      const actual = declared.get(id) ?? licence;
      counts.set(actual, (counts.get(actual) ?? 0) + 1);
      if (!isAllowed(actual)) failures.push(`${id}: ${actual}`);
    }
  }
}

for (const [licence, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${licence}: ${n}`);
if (failures.length > 0) {
  console.error(`\nNot on the allowed list:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
