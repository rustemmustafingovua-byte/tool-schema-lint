import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixTools, applyFixesToData, formatDiff, lintTools, suggestDescription, LIMITS } from "../src/index.js"

const CLI = resolve("bin/tool-schema-lint.js")

const sampleTools = [
  {
    name: "read_file",
    description: "Reads a file from disk and returns its content. Required input: path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "absolute path" } },
      required: ["path"],
    },
  },
  {
    name: "search_docs",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "run_job",
    description: "Runs a job.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
]

test("fixTools rewrites missing and vague descriptions without mutating input", () => {
  const snapshot = JSON.stringify(sampleTools)
  const { tools, changes } = fixTools(sampleTools)
  assert.equal(JSON.stringify(sampleTools), snapshot)
  assert.equal(changes.length, 2)
  assert.equal(tools[0].description, sampleTools[0].description)
  assert.match(tools[1].description, /query/)
  assert.match(tools[1].description, /limit/)
  assert.match(tools[2].description, /id/)
  assert.equal(lintTools(tools).errors, 0)
})

test("applyFixesToData preserves { tools } object wrapper and extra fields", () => {
  const payload = { server: "demo", tools: sampleTools }
  const { data, changes } = applyFixesToData(payload)
  assert.equal(data.server, "demo")
  assert.equal(changes.length, 2)
  assert.equal(data.tools.length, 3)
})

test("fixTools preserves existing description semantics when adding input hints", () => {
  const destructive = [
    {
      name: "delete_record",
      description: "Permanently deletes the selected record; this operation cannot be undone.",
      inputSchema: {
        type: "object",
        properties: { record_id: { type: "string" } },
        required: ["record_id"],
      },
    },
  ]
  const { tools, changes } = fixTools(destructive)
  assert.equal(changes.length, 1)
  assert.match(tools[0].description, /Permanently deletes the selected record; this operation cannot be undone\./)
  assert.match(tools[0].description, /Required input: record_id\./)
  assert.equal(lintTools(tools).issues.length, 0)
})

test("fixTools keeps generated descriptions within LIMITS.maxDescriptionChars and skips unsafe oversized rewrites", () => {
  const manyProps = {}
  const manyReq = []
  for (let i = 0; i < 25; i += 1) {
    const key = `required_parameter_${String(i).padStart(2, "0")}`
    manyProps[key] = { type: "string" }
    manyReq.push(key)
  }
  const missingMany = [{ name: "bulk_import", inputSchema: { type: "object", properties: manyProps, required: manyReq } }]
  const suggested = suggestDescription(missingMany[0])
  assert.ok(suggested.length <= LIMITS.maxDescriptionChars)
  const { tools: fixedMissing } = fixTools(missingMany)
  assert.ok(fixedMissing[0].description.length <= LIMITS.maxDescriptionChars)

  const oversized = [
    {
      name: "legacy_tool",
      description: `${"Important operational note. ".repeat(20)}Required input: required_parameter_00.`,
      inputSchema: { type: "object", properties: manyProps, required: manyReq },
    },
  ]
  const { tools: fixedOversized, changes } = fixTools(oversized)
  assert.equal(changes.length, 0)
  assert.equal(fixedOversized[0].description, oversized[0].description)
})

test("formatDiff renders valid unified diff hunks from original and rewritten JSON", () => {
  const original = `${JSON.stringify(sampleTools, null, 2)}\n`
  const { data } = applyFixesToData(sampleTools)
  const updated = `${JSON.stringify(data, null, 2)}\n`
  const diff = formatDiff(original, updated, "tools.json")
  assert.match(diff, /^--- a\/tools\.json/m)
  assert.match(diff, /^\+\+\+ b\/tools\.json/m)
  assert.match(diff, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m)
  assert.match(diff, /^\+\s+"description": "search_docs:/m)
  assert.match(diff, /^-\s+"description": "Runs a job\.",$/m)
  assert.match(diff, /^\+\s+"description": "Runs a job\. Required input: id\.",$/m)
})

test("CLI --fix writes updated tools.json and preserves original as backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsl-fix-"))
  try {
    const file = join(dir, "tools.json")
    const original = JSON.stringify({ server: "mcp-demo", tools: sampleTools }, null, 2)
    writeFileSync(file, original, "utf8")

    const out = execFileSync(process.execPath, [CLI, file, "--fix"], { encoding: "utf8" })
    assert.match(out, /Rewrote 2 description\(s\)/)

    const backup = `${file}.bak`
    assert.ok(existsSync(backup))
    assert.equal(readFileSync(backup, "utf8"), original)

    const updated = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(updated.server, "mcp-demo")
    assert.equal(lintTools(updated.tools).errors, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("CLI --fix does not overwrite an existing .bak file on subsequent runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsl-bak-"))
  try {
    const file = join(dir, "tools.json")
    writeFileSync(`${file}.bak`, "ORIGINAL_BACKUP", "utf8")
    writeFileSync(file, JSON.stringify(sampleTools, null, 2), "utf8")

    execFileSync(process.execPath, [CLI, file, "--fix"], { encoding: "utf8" })
    assert.equal(readFileSync(`${file}.bak`, "utf8"), "ORIGINAL_BACKUP")
    assert.ok(existsSync(`${file}.bak.1`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("CLI --dry-run prints the diff without modifying the file or creating a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsl-dry-"))
  try {
    const file = join(dir, "tools.json")
    const original = JSON.stringify(sampleTools, null, 2)
    writeFileSync(file, original, "utf8")

    let out = ""
    try {
      out = execFileSync(process.execPath, [CLI, file, "--fix", "--dry-run"], { encoding: "utf8" })
    } catch (err) {
      // Dry run does not modify the file, so error-level findings still return exit code 1.
      out = err.stdout
      assert.equal(err.status, 1)
    }
    assert.match(out, /--- dry-run diff ---/)
    assert.match(out, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m)
    assert.match(out, /^\+\s+"description": "search_docs:/m)
    assert.equal(readFileSync(file, "utf8"), original)
    assert.equal(existsSync(`${file}.bak`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
