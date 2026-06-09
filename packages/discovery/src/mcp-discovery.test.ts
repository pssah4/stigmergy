import { describe, it, expect } from 'vitest'
import { discoverMcpTools, type McpClientLike } from './mcp-discovery.js'

describe('discoverMcpTools', () => {
  it('lists a server tools via the injected client and maps them to mcp capabilities', async () => {
    let closed = false
    const fake: McpClientLike = {
      listTools: async () => ({
        tools: [
          { name: 'read_file', description: 'Read a file', inputSchema: { properties: { path: {} } } },
          { name: 'list_dir' },
        ],
      }),
      close: async () => {
        closed = true
      },
    }
    const caps = await discoverMcpTools({ name: 'fs', command: 'x' }, async () => fake)
    expect(caps.map((c) => c.id)).toEqual(['mcp:fs:read_file', 'mcp:fs:list_dir'])
    expect(caps[0]!.description).toBe('Read a file (params: path)')
    expect(caps.every((c) => c.type === 'mcp' && c.source === 'mcp')).toBe(true)
    expect(closed).toBe(true) // the client is closed after listing
  })

  it('closes the client even if listing throws', async () => {
    let closed = false
    const fake: McpClientLike = {
      listTools: async () => {
        throw new Error('boom')
      },
      close: async () => {
        closed = true
      },
    }
    await expect(discoverMcpTools({ name: 's', command: 'x' }, async () => fake)).rejects.toThrow('boom')
    expect(closed).toBe(true)
  })
})
