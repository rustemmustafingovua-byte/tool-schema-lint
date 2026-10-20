// Integration test against the real service. Skipped unless LIVE=1.
//   LIVE=1 npm test
import { test } from "node:test"
import assert from "node:assert/strict"

const LIVE = process.env.LIVE === "1"
const skip = LIVE ? false : "set LIVE=1 to run the integration test"

import { lintTools } from "../src/index.js"

test("lints a real tool list from an MCP server", { skip }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
  const transport = new StdioClientTransport({
    command: "node",
    args: ["/Users/admin/workspace/free-web-mcp/bin/free-web-mcp.js"],
  })
  const client = new Client({ name: "lint-test", version: "0.1.0" }, { capabilities: {} })
  await client.connect(transport)
  const { tools } = await client.listTools()
  await client.close()
  const report = lintTools(tools)
  assert.ok(report.tools >= 5)
  assert.equal(report.errors, 0, "our own tools should have no error-level findings")
})
