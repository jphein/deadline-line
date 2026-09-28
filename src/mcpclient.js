// mcpclient.js — minimal stateless Streamable HTTP MCP client for the Deadline Decoder server.
let id = 0;
export function mcpClient(url = process.env.DD_MCP_URL || "http://127.0.0.1:8766/mcp") {
  return async function callTool(name, args) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`MCP ${name}: ${body.error.message}`);
    if (body.result.isError) throw new Error(`MCP ${name}: ${body.result.content?.[0]?.text}`);
    return body.result.structuredContent;
  };
}
