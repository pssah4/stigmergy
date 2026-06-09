// @stigmergy/llm public surface (FEAT-01-07, ADR-11): the ported provider layer (classifyText)
// plus the capability augmenter that plugs into the core CapabilityAugmenter seam.
export * from './types.js'
export * from './factory.js'
export * from './fake.js'
export * from './crypter.js'
export * from './model-registry.js'
export * from './tier.js'
export * from './pricing.js'
export * from './capability-augmenter.js'
export * from './discovery.js'
export * from './embedding.js'
export { AnthropicHandler } from './providers/anthropic.js'
export { OpenAiCompatibleHandler } from './providers/openai-compatible.js'
