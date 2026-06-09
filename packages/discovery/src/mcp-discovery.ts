// MCP discovery driver (ADR-17, FEAT-04-02). Connects to a configured MCP server, calls tools/list,
// and normalizes each tool to an 'mcp' capability. The transport (the @modelcontextprotocol/sdk
// client) is reached only through the injectable `connect`, so the pure mapping is unit-tested with a
// fake client and the SDK is never loaded in tests. The default connect lazy-imports the SDK via a
// variable specifier, which keeps it type-optional (tsc does not resolve the SDK's subpath types) and
// resolves the .js paths at runtime under NodeNext.
import type { RegisterCapabilityInput } from '@agentic-stigmergy/core'
import { mcpToolToCapability, type McpTool } from './index.js'

/** A configured MCP server. `url` selects the streamable-HTTP transport; otherwise stdio spawns
 * `command` with `args`. The host supplies this (trust anchor); it is never derived from upstream. */
export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  url?: string
}

/** The slice of an MCP client this driver needs. The real SDK client satisfies it; tests fake it. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpTool[] }>
  close(): Promise<void>
}

export type McpConnect = (server: McpServerConfig) => Promise<McpClientLike>

interface SdkClient {
  connect(transport: unknown): Promise<void>
  listTools(): Promise<unknown>
  close(): Promise<void>
}

// A variable specifier makes tsc treat the dynamic import as `any`, so the SDK stays type-optional;
// Node resolves the .js subpaths at runtime via the package's `./*` export.
const importDynamic = (specifier: string): Promise<Record<string, unknown>> => import(specifier)

const realConnect: McpConnect = async (server) => {
  const clientMod = (await importDynamic('@modelcontextprotocol/sdk/client/index.js')) as {
    Client: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => SdkClient
  }
  let transport: unknown
  if (server.url) {
    const mod = (await importDynamic('@modelcontextprotocol/sdk/client/streamableHttp.js')) as {
      StreamableHTTPClientTransport: new (url: URL) => unknown
    }
    transport = new mod.StreamableHTTPClientTransport(new URL(server.url))
  } else {
    const mod = (await importDynamic('@modelcontextprotocol/sdk/client/stdio.js')) as {
      StdioClientTransport: new (opts: { command: string; args: string[] }) => unknown
    }
    transport = new mod.StdioClientTransport({ command: server.command ?? '', args: server.args ?? [] })
  }
  const client = new clientMod.Client({ name: 'stigmergy-discovery', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return {
    listTools: async () => {
      const result = (await client.listTools()) as { tools?: McpTool[] }
      return { tools: result.tools ?? [] }
    },
    close: () => client.close(),
  }
}

/** Connect to an MCP server, enumerate its tools (tools/list) and map each to an 'mcp' capability.
 * The client is always closed, even if listing throws. Inject `connect` in tests; the default uses
 * the real SDK transport. */
export async function discoverMcpTools(
  server: McpServerConfig,
  connect: McpConnect = realConnect,
): Promise<RegisterCapabilityInput[]> {
  const client = await connect(server)
  try {
    const { tools } = await client.listTools()
    return tools.map((t) => mcpToolToCapability(server.name, t))
  } finally {
    await client.close().catch(() => {
      /* a failure to close must not mask the discovery result or error */
    })
  }
}
