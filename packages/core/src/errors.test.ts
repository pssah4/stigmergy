import { describe, it, expect } from 'vitest'
import { StigmergyError, SchemaError, LockError, ValidationError } from './errors.js'

describe('error hierarchy', () => {
  it('subclasses extend StigmergyError and Error', () => {
    for (const E of [SchemaError, LockError, ValidationError]) {
      const e = new E('x')
      expect(e).toBeInstanceOf(StigmergyError)
      expect(e).toBeInstanceOf(Error)
    }
  })

  it('carries the message and a specific name', () => {
    const e = new ValidationError('reset requires destroy:true')
    expect(e.message).toBe('reset requires destroy:true')
    expect(e.name).toBe('ValidationError')
  })
})
