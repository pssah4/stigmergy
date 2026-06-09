// Typed error hierarchy (FEAT-01-04 NFR: specific subclasses instead of generic Error).

export class StigmergyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StigmergyError'
  }
}

export class SchemaError extends StigmergyError {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

export class LockError extends StigmergyError {
  constructor(message: string) {
    super(message)
    this.name = 'LockError'
  }
}

export class ValidationError extends StigmergyError {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
