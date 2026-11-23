#!/usr/bin/env node
/**
 * tool-schema-lint — check MCP tool definitions before your agent misuses them.
 *
 *   tool-schema-lint tools.json
 *   tool-schema-lint --stdin < tools.json
 *   tool-schema-lint tools.json --suggest
 *   tool-schema-lint tools.json --fix
 *   tool-schema-lint tools.json --fix --dry-run
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs"
import { lintTools, suggestDescription, applyFixesToData, formatDiff } from "../src/index.js"

// --- CLI shell: --help / --version -------------------------------------------
const HELP = "tool-schema-lint — Lint MCP tool schemas before your agent misuses them.\n\nUSAGE\n  tool-schema-lint tools.json\n  tool-schema-lint --stdin < tools.json\n  tool-schema-lint tools.json --suggest\n  tool-schema-lint tools.json --fix\n  tool-schema-lint tools.json --fix --dry-run\n\nCOMMANDS / OPTIONS\n  --stdin    read the tool list from standard input\n  --suggest  print a rewritten description for every tool with findings\n  --fix      rewrite descriptions into tools.json and keep the original as a .bak backup\n  --dry-run  print the unified diff of description fixes without modifying files\n\nExit code 1 when a tool has an error-level finding.\n\nMIT · https://github.com/rustemmustafingovua-byte"
const VERSION = "0.1.0"
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(VERSION)
  process.exit(0)
}

function nextBackupPath(filePath) {
  const base = `${filePath}.bak`
  if (!existsSync(base)) return base
  // Avoid clobbering an earlier backup if --fix is run more than once.
  let n = 1
  while (existsSync(`${base}.${n}`)) n += 1
  return `${base}.${n}`
}

const argv = process.argv.slice(2)
const useStdin = argv.includes("--stdin")
const wantSuggest = argv.includes("--suggest")
const wantFix = argv.includes("--fix")
const wantDryRun = argv.includes("--dry-run")

let file = null
let raw = ""
if (useStdin) {
  if (wantFix && !wantDryRun) {
    console.error("error: --fix requires a file path (use --dry-run with --stdin to preview)")
    process.exit(2)
  }
  raw = readFileSync(0, "utf8")
} else {
  file = argv.find((a) => !a.startsWith("--"))
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

if (wantSuggest) {
  console.log("\n--- suggested descriptions ---")
  for (let idx = 0; idx < tools.length; idx += 1) {
    const t = tools[idx]
    const r = report.perTool[idx]
    if (r && r.issues.length) {
      console.log(`\n${t.name}:\n  ${suggestDescription(t)}`)
    }
  }
}

let finalReport = report
if (wantFix || wantDryRun) {
  const { data: updatedData, tools: fixedTools, changes } = applyFixesToData(data)
  if (!changes.length) {
    console.log("\nNo description fixes needed.")
  } else if (wantDryRun) {
    console.log("\n--- dry-run diff ---")
    console.log(formatDiff(changes, file || "stdin"))
  } else {
    const backupPath = nextBackupPath(file)
    copyFileSync(file, backupPath)
    writeFileSync(file, `${JSON.stringify(updatedData, null, 2)}\n`, "utf8")
    finalReport = lintTools(fixedTools)
    console.log(`\nRewrote ${changes.length} description(s) in ${file} (backup: ${backupPath})`)
    console.log(`after fix: score ${finalReport.score}/100  ·  errors ${finalReport.errors} · warnings ${finalReport.warns}  →  ${finalReport.verdict}`)
  }
}

if (finalReport.errors) process.exitCode = 1
