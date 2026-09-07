"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
let count = 0;
for (const directory of [".", "core", "sources", "protocols", "public", "test"]) {
  const root = path.join(__dirname, directory);
  if (!fs.existsSync(root)) continue;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:cjs|mjs|js)$/.test(entry.name)) continue;
    execFileSync(process.execPath, ["--check", path.join(root, entry.name)], { stdio: "inherit" });
    count++;
  }
}
console.log(`Syntax checked ${count} application and test files`);
