#!/usr/bin/env node
/**
 * tool-schema-lint — check MCP tool definitions before your agent misuses them.
 *
 *   tool-schema-lint tools.json
 *   tool-schema-lint --stdin < tools.json
 *   tool-schema-lint --suggest
 */
import { readFileSync, existsSync } from "node:fs"
import { lintTools, suggestDescription, RULES } from "../src/index.js"

// --- CLI shell: --help / --version -------------------------------------------
const HELP = "tool-schema-lint — Lint MCP tool schemas before your agent misuses them.\n\nUSAGE\n  tool-schema-lint tools.json\n  tool-schema-lint --stdin < tools.json\n  tool-schema-lint tools.json --suggest\n\nCOMMANDS / OPTIONS\n  --stdin    read the tool list from standard input\n  --suggest  print a rewritten description for every tool with findings\n\nExit code 1 when a tool has an error-level finding.\n\nMIT · https://github.com/rustemmustafingovua-byte"
const VERSION = "0.1.0"
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION)
  process.exit(0)
}


const argv = process.argv.slice(2)
let raw = ""
if (argv.includes("--stdin")) {
  raw = readFileSync(0, "utf8")
} else {
  const file = argv.find((a) => !a.startsWith("--"))
  if (!file || !existsSync(file)) {
    console.error("usage: tool-schema-lint <tools.json> | --stdin")
    process.exit(2)
  }
  raw = readFileSync(file, "utf8")
}
const data = JSON.parse(raw)
const tools = Array.isArray(data) ? data : data.tools || []
const report = lintTools(tools)

console.log(`\n${report.tools} tool(s)  ·  score ${report.score}/100  ·  ~${report.tokens} tokens of schema`)
console.log(`errors ${report.errors} · warnings ${report.warns} · info ${report.infos}  →  ${report.verdict}\n`)
for (const i of report.issues) {
  const mark = i.severity === "error" ? "✗" : i.severity === "warn" ? "!" : "·"
  console.log(`  ${mark} [${i.tool || "-"}] ${i.rule}${i.detail ? " — " + i.detail : ""}`)
}
if (argv.includes("--suggest")) {
  console.log("\n--- suggested descriptions ---")
  for (const t of tools) {
    const r = report.perTool.find((p) => p.name === t.name)
    if (r && r.issues.length) {
      console.log(`\n${t.name}:\n  ${suggestDescription(t)}`)
    }
  }
}
if (report.errors) process.exitCode = 1
