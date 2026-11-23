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

function formatBoundedList(items, budget) {
  if (!items.length || budget <= 0) return ""
  const kept = []
  let len = 0
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const remaining = items.length - (i + 1)
    const suffix = remaining > 0 ? `, +${remaining} more` : ""
    const sep = kept.length ? ", " : ""
    if (len + sep.length + item.length + suffix.length <= budget) {
      kept.push(item)
      len += sep.length + item.length
    } else {
      break
    }
  }
  if (!kept.length) return `${items.length} param(s)`
  const leftover = items.length - kept.length
  return leftover > 0 ? `${kept.join(", ")}, +${leftover} more` : kept.join(", ")
}

function buildInputClause(tool, maxChars) {
  const p = props(tool)
  const req = required(tool)
  const keys = Object.keys(p)
  if (!keys.length) return ""
  const optional = keys.filter((k) => !req.includes(k))

  const fullReq = req.join(", ")
  const fullOpt = optional.join(", ")
  const full = fullReq
    ? `Required input: ${fullReq}.` + (fullOpt ? ` Optional: ${fullOpt}.` : "")
    : `Optional input: ${fullOpt}.`
  if (full.length <= maxChars) return full

  if (req.length) {
    const prefix = "Required input: "
    const optSuffix = optional.length ? ` Optional: ${optional.length} param(s).` : ""
    const reqBudget = maxChars - prefix.length - 1 - optSuffix.length
    if (reqBudget >= 6) {
      const candidate = `${prefix}${formatBoundedList(req, reqBudget)}.${optSuffix}`
      if (candidate.length <= maxChars) return candidate
    }
    const compact = `${prefix}${req.length} param(s).`
    return compact.length <= maxChars ? compact : ""
  }

  const prefix = "Optional input: "
  const optBudget = maxChars - prefix.length - 1
  if (optBudget >= 6) {
    const candidate = `${prefix}${formatBoundedList(optional, optBudget)}.`
    if (candidate.length <= maxChars) return candidate
  }
  const compact = `${prefix}${optional.length} param(s).`
  return compact.length <= maxChars ? compact : ""
}

/** Suggest a rewritten description, bounded within LIMITS.maxDescriptionChars. */
export function suggestDescription(tool) {
  const keys = Object.keys(props(tool))
  const name = tool?.name || "tool"
  if (!keys.length) return `Describe what ${name} does and what it returns.`.slice(0, LIMITS.maxDescriptionChars)
  const head = `${name}: does one thing and says so. `
  const tail = ` Returns the result directly; explain errors in the response.`
  const budget = LIMITS.maxDescriptionChars - head.length - tail.length
  const inputClause = buildInputClause(tool, Math.max(0, budget))
  if (inputClause && head.length + inputClause.length + tail.length <= LIMITS.maxDescriptionChars) {
    return `${head}${inputClause}${tail}`
  }
  const shortBudget = LIMITS.maxDescriptionChars - head.length
  const compactClause = buildInputClause(tool, Math.max(0, shortBudget))
  return `${head}${compactClause}`.trim().slice(0, LIMITS.maxDescriptionChars)
}

function descriptionFindingCount(tool) {
  const descLen = typeof tool?.description === "string" ? tool.description.length : 0
  return lintTool(tool).issues.filter(
    (issue) =>
      issue.rule === RULES.MISSING_DESCRIPTION ||
      issue.rule === RULES.VAGUE_DESCRIPTION ||
      (issue.rule === RULES.OVERSIZED && descLen > LIMITS.maxDescriptionChars),
  ).length
}

/**
 * Compute a safe automatic description fix that preserves existing operational meaning
 * and stays within LIMITS.maxDescriptionChars. Returns null when an automatic rewrite
 * cannot safely resolve the finding (caller leaves it as a manual suggestion).
 */
function buildSafeDescriptionFix(tool, toolReport) {
  if (!toolReport?.issues?.length) return null
  const current = typeof tool?.description === "string" ? tool.description.trim() : ""
  const hasMissing = toolReport.issues.some((i) => i.rule === RULES.MISSING_DESCRIPTION)
  const hasVague = toolReport.issues.some((i) => i.rule === RULES.VAGUE_DESCRIPTION)

  let candidate = null
  if (hasMissing || !current) {
    candidate = suggestDescription(tool)
  } else if (hasVague && current.length <= LIMITS.maxDescriptionChars) {
    // Preserve the original description text and append a bounded input hint.
    const base = /[.!?]$/.test(current) ? current : `${current}.`
    const remaining = LIMITS.maxDescriptionChars - base.length - 1
    const clause = buildInputClause(tool, remaining)
    if (!clause) return null
    candidate = `${base} ${clause}`
  } else {
    // Oversized existing descriptions require human editing so operational details are not lost.
    return null
  }

  if (!candidate || candidate === tool?.description) return null
  if (candidate.length > LIMITS.maxDescriptionChars) return null
  const beforeCount = descriptionFindingCount(tool)
  const afterCount = descriptionFindingCount({ ...tool, description: candidate })
  if (afterCount >= beforeCount) return null
  return candidate
}

/**
 * Rewrite descriptions for tools where an automatic fix is safe and resolves findings.
 * Returns cloned tools so callers can inspect or diff without mutating input.
 */
export function fixTools(tools) {
  const report = lintTools(tools)
  const changes = []
  const fixed = tools.map((tool, index) => {
    const toolReport = report.perTool[index]
    const after = buildSafeDescriptionFix(tool, toolReport)
    if (!after) return { ...tool }
    const before = tool?.description
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

function splitLines(text) {
  const normalized = String(text).replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function lcsDiffOps(a, b) {
  const m = a.length
  const n = b.length
  // Trim common prefix/suffix so diffing large JSON files stays fast and tiny in memory.
  let start = 0
  while (start < m && start < n && a[start] === b[start]) start += 1
  let endA = m
  let endB = n
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const ops = []
  for (let i = 0; i < start; i += 1) ops.push({ type: " ", line: a[i], oldLine: i + 1, newLine: i + 1 })

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const ma = midA.length
  const mb = midB.length
  const dp = Array.from({ length: ma + 1 }, () => new Int32Array(mb + 1))
  for (let i = ma - 1; i >= 0; i -= 1) {
    for (let j = mb - 1; j >= 0; j -= 1) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < ma && j < mb) {
    if (midA[i] === midB[j]) {
      ops.push({ type: " ", line: midA[i], oldLine: start + i + 1, newLine: start + j + 1 })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", line: midA[i], oldLine: start + i + 1, newLine: start + j + 1 })
      i += 1
    } else {
      ops.push({ type: "+", line: midB[j], oldLine: start + i + 1, newLine: start + j + 1 })
      j += 1
    }
  }
  while (i < ma) {
    ops.push({ type: "-", line: midA[i], oldLine: start + i + 1, newLine: start + j + 1 })
    i += 1
  }
  while (j < mb) {
    ops.push({ type: "+", line: midB[j], oldLine: start + i + 1, newLine: start + j + 1 })
    j += 1
  }

  for (let k = 0; k < m - endA; k += 1) {
    ops.push({ type: " ", line: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 })
  }
  return ops
}

/** Format two text versions as a standard unified diff with valid @@ -a,b +c,d @@ hunks. */
export function formatDiff(beforeText, afterText, label = "tools.json", context = 3) {
  const a = splitLines(beforeText)
  const b = splitLines(afterText)
  const ops = lcsDiffOps(a, b)
  const changeIndices = []
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (ops[idx].type !== " ") changeIndices.push(idx)
  }
  if (!changeIndices.length) return ""

  // Group nearby changes within 2 * context lines into hunks.
  const hunks = []
  let hStart = Math.max(0, changeIndices[0] - context)
  let hEnd = Math.min(ops.length - 1, changeIndices[0] + context)
  for (let c = 1; c < changeIndices.length; c += 1) {
    const nextStart = Math.max(0, changeIndices[c] - context)
    const nextEnd = Math.min(ops.length - 1, changeIndices[c] + context)
    if (nextStart <= hEnd + 1) {
      hEnd = nextEnd
    } else {
      hunks.push([hStart, hEnd])
      hStart = nextStart
      hEnd = nextEnd
    }
  }
  hunks.push([hStart, hEnd])

  const out = [`--- a/${label}`, `+++ b/${label}`]
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1)
    const oldCount = slice.filter((o) => o.type !== "+").length
    const newCount = slice.filter((o) => o.type !== "-").length
    const firstOld = slice.find((o) => o.type !== "+")?.oldLine ?? 1
    const firstNew = slice.find((o) => o.type !== "-")?.newLine ?? 1
    const oldStart = oldCount === 0 ? Math.max(0, firstOld - 1) : firstOld
    const newStart = newCount === 0 ? Math.max(0, firstNew - 1) : firstNew
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of slice) out.push(`${op.type}${op.line}`)
  }
  return out.join("\n")
}
