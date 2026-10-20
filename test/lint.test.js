import { test } from "node:test"
import assert from "node:assert/strict"
import { lintTool, lintTools, estimateTokens, suggestDescription, RULES } from "../src/index.js"

const good = {
  name: "read_file",
  description: "Reads a file from disk and returns its content. Required input: path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "absolute path" }, encoding: { type: "string" } },
    required: ["path"],
  },
}

test("a well written tool passes", () => {
  const r = lintTool(good)
  assert.equal(r.issues.filter((i) => i.severity === "error").length, 0)
})

test("a missing description is an error", () => {
  const r = lintTool({ name: "x" })
  assert.equal(r.issues[0].rule, RULES.MISSING_DESCRIPTION)
  assert.equal(r.issues[0].severity, "error")
})

test("a description that never mentions the input is flagged", () => {
  const r = lintTool({
    name: "do_thing",
    description: "Does a thing.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
  })
  assert.ok(r.issues.some((i) => i.rule === RULES.VAGUE_DESCRIPTION))
})

test("optional parameters without a default are warned about", () => {
  const r = lintTool({
    name: "do_thing",
    description: "Does a thing with the required input target.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, mode: { type: "string" } }, required: ["target"] },
  })
  assert.ok(r.issues.some((i) => i.rule === RULES.OPTIONAL_WITHOUT_DEFAULT))
})

test("duplicate tool names are errors", () => {
  const report = lintTools([good, { ...good }])
  assert.equal(report.errors, 1)
  assert.ok(report.issues.some((i) => i.rule === RULES.DUPLICATE))
})

test("scoring penalises problems", () => {
  const clean = lintTools([good]).score
  const dirty = lintTools([{ name: "x" }, { name: "y" }]).score
  assert.ok(clean > dirty)
})

test("token estimation is sane", () => {
  assert.ok(estimateTokens("hello world") >= 2)
  assert.equal(estimateTokens(""), 0)
})

test("suggestions name the required input", () => {
  const s = suggestDescription(good)
  assert.match(s, /path/)
})
