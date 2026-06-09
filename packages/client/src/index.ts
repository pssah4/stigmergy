// @agentic-stigmergy/client: the host-side client transport (ADR-12, ADR-20, FEAT-04-08, FEAT-04-09). A host
// either keeps a local engine and only delegates consult to a warm daemon (connectEngine), or runs as
// a pure remote client with no local engine (createRemoteEngine): consult, emit and registerCapability
// all go over the socket, with graceful degrade when the daemon is down.
export {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
  type ConsultRequest,
  type ConsultResponse,
  type EmitRequest,
  type RegisterRequest,
  type IsEnabledRequest,
  type PingRequest,
  type RpcRequest,
  type RpcResponse,
  type OkResponse,
  type IsEnabledResponse,
} from './protocol.js'
export { createConsultClient, connectEngine, createRemoteEngine, type ConsultLike, type RemoteEngine, type RemoteErrorSink, type RpcSend } from './client.js'
export { handleConsultRequest, handleRequest, type ConsultLikeServer, type EngineLikeServer } from './server.js'
export { serveConsult, serveEngine, socketRpcSend } from './socket.js'
