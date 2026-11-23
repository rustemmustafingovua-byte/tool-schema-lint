/**
 * tool-schema-lint — lint MCP tool definitions.
 *
 * Agents call tools wrongly when the schema is ambiguous. This checks the
 * things that actually cause that: a missing description, a description that
 * does not say what the input is, optional parameters with no default, string
 * formats that should be enums, and schemas so large they eat the context.
 */
export const RULES = {
  MISSING_DESCRIPTION: "missing description",
  VAGUE_DESCRIPTION: "description does not mention the input",
  NO_INPUT_HINT: "no hint what the arguments look like",
  OPTIONAL_WITHOUT_DEFAULT: "optional parameter without a default",
  FREE_FORM_STRING: "free-form string that should be an enum",
  OVERSIZED: "schema is oversized",
  AMBIGUOUS_NAME: "name does not say what it does",
  DUPLICATE: "duplicate tool name",
}

export const LIMITS = {
  maxDescriptionChars: 400,
  maxSchemaChars: 6000,
  maxTools: 60,
}

function props(tool) {
  return tool?.inputSchema?.properties || tool?.parameters?.properties || {}
}

function required(tool) {
  return tool?.inputSchema?.required || tool?.parameters?.required || []
}

/** Rough token estimate: ~4 characters per token, word-aware. */
export function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  const words = s.split(/\s+/).filter(Boolean).length
  return Math.max(Math.ceil(s.length / 4), Math.ceil(words * 1.3))
}

/** Lint a single tool. */
export function lintTool(tool, { seen = new Set() } = {}) {
  const issues = []
  const name = tool?.name || ""
  const description = tool?.description || ""
  const schema = tool?.inputSchema || tool?.parameters || {}
  const p = props(tool)
  const req = required(tool)

  if (!description) issues.push({ rule: RULES.MISSING_DESCRIPTION, severity: "error", tool: name })
  else {
    if (description.length > LIMITS.maxDescriptionChars)
      issues.push({ rule: RULES.OVERSIZED, severity: "warn", tool: name, detail: `${description.length} chars` })
    const hasInputWords = /\b(input|argument|param|accepts|requires|with|by|of|for)\b/i.test(description)
    const hasParams = Object.keys(p).length > 0
    if (hasParams && !hasInputWords)
      issues.push({ rule: RULES.VAGUE_DESCRIPTION, severity: "warn", tool: name })
  }

  if (name && !/^[a-z][a-z0-9_]*$/.test(name))
    issues.push({ rule: RULES.AMBIGUOUS_NAME, severity: "warn", tool: name, detail: "use snake_case" })
  if (seen.has(name)) issues.push({ rule: RULES.DUPLICATE, severity: "error", tool: name })
  seen.add(name)

  for (const [key, schema2] of Object.entries(p)) {
    if (req.includes(key)) continue
    if (schema2 && schema2.default === undefined && !schema2.description)
      issues.push({ rule: RULES.OPTIONAL_WITHOUT_DEFAULT, severity: "warn", tool: name, detail: key })
    if (schema2?.type === "string" && !schema2.enum && !schema2.format)
      issues.push({ rule: RULES.FREE_FORM_STRING, severity: "info", tool: name, detail: key })
  }

  const schemaChars = JSON.stringify(schema).length
  if (schemaChars > LIMITS.maxSchemaChars)
    issues.push({ rule: RULES.OVERSIZED, severity: "warn", tool: name, detail: `${schemaChars} chars` })

  return { name, issues, tokens: estimateTokens(JSON.stringify(tool)) }
}

/** Lint a whole tool list. */
export function lintTools(tools) {
  const seen = new Set()
  const perTool = tools.map((t) => lintTool(t, { seen }))
  const issues = perTool.flatMap((t) => t.issues)
  const errors = issues.filter((i) => i.severity === "error").length
  const warns = issues.filter((i) => i.severity === "warn").length
  const infos = issues.filter((i) => i.severity === "info").length
  const totalTokens = perTool.reduce((n, t) => n + t.tokens, 0)
  const score = Math.max(0, Math.round(100 - errors * 12 - warns * 4 - infos))
  return {
    tools: tools.length,
    errors,
    warns,
    infos,
    tokens: totalTokens,
    score,
    issues,
    perTool,
    verdict:
      errors > 0 ? "broken" : warns > 0 ? "usable but improvable" : "clean",
  }
}

/** Suggest a rewritten description. */
export function suggestDescription(tool) {
  const p = props(tool)
  const req = required(tool)
  const keys = Object.keys(p)
  if (!keys.length) return `Describe what ${tool.name} does and what it returns.`
  const requiredList = req.join(", ")
  const optional = keys.filter((k) => !req.includes(k)).join(", ")
  const inputClause = requiredList
    ? `Required input: ${requiredList}.` + (optional ? ` Optional: ${optional}.` : "")
    : `Optional input: ${optional}.`
  return (
    `${tool.name}: does one thing and says so. ` +
    `${inputClause} ` +
    `Returns the result directly; explain errors in the response.`
  )
}

function needsDescriptionFix(tool, toolReport) {
  if (!toolReport?.issues?.length) return false
  const descLen = typeof tool?.description === "string" ? tool.description.length : 0
  return toolReport.issues.some(
    (issue) =>
      issue.rule === RULES.MISSING_DESCRIPTION ||
      issue.rule === RULES.VAGUE_DESCRIPTION ||
      (issue.rule === RULES.OVERSIZED && descLen > LIMITS.maxDescriptionChars),
  )
}

/**
 * Rewrite descriptions for tools with description findings.
 * Returns cloned tools so callers can inspect or diff without mutating input.
 */
export function fixTools(tools) {
  const report = lintTools(tools)
  const changes = []
  const fixed = tools.map((tool, index) => {
    const toolReport = report.perTool[index]
    if (!needsDescriptionFix(tool, toolReport)) return { ...tool }
    const before = tool?.description
    const after = suggestDescription(tool)
    if (before === after) return { ...tool }
    changes.push({ index, name: tool?.name || `#${index}`, before, after })
    return { ...tool, description: after }
  })
  return { tools: fixed, changes }
}

/** Apply description fixes while preserving either an array or { tools } envelope. */
export function applyFixesToData(data) {
  const isArray = Array.isArray(data)
  const tools = isArray ? data : data?.tools || []
  const { tools: fixedTools, changes } = fixTools(tools)
  const updated = isArray ? fixedTools : { ...data, tools: fixedTools }
  return { data: updated, tools: fixedTools, changes }
}

/** Format description changes as a readable unified diff for --dry-run output. */
export function formatDiff(changes, label = "tools.json") {
  if (!changes.length) return ""
  const lines = [`--- a/${label}`, `+++ b/${label}`]
  for (const change of changes) {
    lines.push(`@@ ${change.name} @@`)
    lines.push(`- description: ${change.before === undefined ? "(missing)" : JSON.stringify(change.before)}`)
    lines.push(`+ description: ${JSON.stringify(change.after)}`)
  }
  return lines.join("\n")
}
