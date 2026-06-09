import { describe, it, expect } from 'vitest'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from './protocol.js'

describe('frame codec (EPIC-04 FEAT-04-08)', () => {
  it('round-trips a single value', () => {
    const dec = new FrameDecoder()
    const out = dec.push(encodeFrame({ type: 'consult', input: { task_id: 't', context: 'x' } }))
    expect(out).toEqual([{ type: 'consult', input: { task_id: 't', context: 'x' } }])
  })

  it('decodes multiple frames delivered in one chunk', () => {
    const dec = new FrameDecoder()
    const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })])
    expect(dec.push(chunk)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('reassembles a frame split across chunks', () => {
    const dec = new FrameDecoder()
    const frame = encodeFrame({ hello: 'world' })
    expect(dec.push(frame.subarray(0, 3))).toEqual([]) // partial header/body -> nothing yet
    expect(dec.push(frame.subarray(3))).toEqual([{ hello: 'world' }])
  })

  // Hardening (pre-merge review wxfcn1jf7): a malformed or oversized frame must throw, never crash the
  // process. The socket layer catches the throw and drops only that connection.
  it('throws on a zero-length frame body (empty JSON) rather than returning silently', () => {
    const dec = new FrameDecoder()
    const header = Buffer.alloc(4) // declares length 0 -> JSON.parse('') would throw
    expect(() => dec.push(header)).toThrow()
  })

  it('throws on a non-JSON frame body', () => {
    const dec = new FrameDecoder()
    const body = Buffer.from('not json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    expect(() => dec.push(Buffer.concat([header, body]))).toThrow()
  })

  it('throws on a declared frame length above MAX_FRAME_BYTES before buffering it (OOM guard)', () => {
    const dec = new FrameDecoder()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => dec.push(header)).toThrow(/frame too large/)
  })
})
