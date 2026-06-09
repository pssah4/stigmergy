import { describe, it, expect } from 'vitest'
import { createEngine, FakeEmbedding, FixedClock } from '@agentic-stigmergy/core'
import { createSqlJsStorage } from '@stigmergy/storage-sqljs'
import { detectFramework, ConnectVerifier } from './index.js'

describe('detectFramework (FEAT-02-08 SC-06)', () => {
  it('detects Vercel AI from the ai dependency', () => {
    const d = detectFramework({ dependencies: { ai: '^4.0.0' } })
    expect(d.framework).toBe('vercel-ai')
    expect(d.integration).toBe('@stigmergy/integration-vercel-ai')
    expect(d.snippet).toContain('createVercelIntegration')
  })

  it('detects LangChain from dependencies or devDependencies', () => {
    expect(detectFramework({ dependencies: { langchain: '^1.0.0' } }).framework).toBe('langchain')
    expect(detectFramework({ devDependencies: { '@langchain/core': '^1.0.0' } }).framework).toBe('langchain')
  })

  it('detects OpenAI Agents', () => {
    const d = detectFramework({ dependencies: { '@openai/agents': '^0.1.0' } })
    expect(d.framework).toBe('openai-agents')
    expect(d.integration).toBe('@stigmergy/integration-openai-agents')
  })

  it('returns unknown with a facade snippet when no supported SDK is present', () => {
    const d = detectFramework({ dependencies: { lodash: '^4.0.0' } })
    expect(d.framework).toBe('unknown')
    expect(d.integration).toBeNull()
    expect(d.snippet).toContain('StigmergyLoop')
    // the facade snippet names all four explorable capability types (IMP-04-10-02)
    expect(d.snippet).toMatch(/skill:/)
    expect(d.snippet).toMatch(/mcp:/)
    expect(d.snippet).toMatch(/subagent:/)
  })
})

describe('ConnectVerifier (FEAT-02-08 SC-05)', () => {
  it('turns green after the first consult and the first event, and still delegates', async () => {
    const engine = await createEngine({
      storage: await createSqlJsStorage(),
      embedding: new FakeEmbedding(),
      clock: new FixedClock(1_700_000_000_000),
    })
    await engine.registerCapability({ id: 'tool:a', type: 'tool', description: 'a helper' })

    let greenFired = false
    const verifier = new ConnectVerifier(engine, () => {
      greenFired = true
    })
    const wrapped = verifier.wrap()
    expect(verifier.status.green).toBe(false)

    await wrapped.emit({ type: 'task_started', taskId: 't1', context: 'a helper' })
    expect(verifier.status).toMatchObject({ eventSeen: true, consultSeen: false, green: false })

    await wrapped.consult({ task_id: 't1', context: 'a helper', candidate_ids: ['tool:a'] })
    await verifier.whenGreen()
    expect(verifier.status.green).toBe(true)
    expect(greenFired).toBe(true)

    // the wrapped engine still delegates other methods unchanged
    expect((await wrapped.stats()).capabilities).toBe(1)
    await wrapped.close()
  })
})
