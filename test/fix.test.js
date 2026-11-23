import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixTools, applyFixesToData, formatDiff, lintTools } from "../src/index.js"

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

test("formatDiff renders unified diff lines for description changes", () => {
  const { changes } = fixTools(sampleTools)
  const diff = formatDiff(changes, "tools.json")
  assert.match(diff, /^--- a\/tools\.json/m)
  assert.match(diff, /^\+\+\+ b\/tools\.json/m)
  assert.match(diff, /@@ search_docs @@/)
  assert.match(diff, /^- description: \(missing\)/m)
  assert.match(diff, /^\+ description: "search_docs:/m)
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
    assert.match(out, /@@ search_docs @@/)
    assert.equal(readFileSync(file, "utf8"), original)
    assert.equal(existsSync(`${file}.bak`), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
