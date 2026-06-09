// @stigmergy/embedding-transformers: EmbeddingPort via transformers.js
// (Xenova/all-MiniLM-L6-v2, 384-dim). In Node, transformers.js runs on the
// onnxruntime-node backend (native, fast). FEAT-01-05, ADR-12.
//
// SECURITY (AUDIT 2):
// - The downloaded ONNX graph is EXECUTED NATIVELY by onnxruntime-node in-process. A tampered
//   model is therefore a native-code surface, not sandboxed data. We pin a model revision (commit
//   SHA) by default so the resolved bytes do not track the mutable `main` branch (CWE-829/A08).
// - transformers.js pulls native-postinstall deps (onnxruntime-node, protobufjs, sharp); keep the
//   lockfile integrity-pinned and run `npm audit --omit=dev` in CI (CWE-1357/A06).
// - For untrusted environments, set localModelPath to a pre-provisioned, hash-verified model so no
//   model is fetched at runtime (allowRemoteModels is then disabled).

import type { EmbeddingPort } from '@agentic-stigmergy/core'
import { ValidationError } from '@agentic-stigmergy/core'

/** Minimal structural shape of the transformers.js feature-extraction output. */
interface ExtractorOutput {
  data: Float32Array | number[]
}
export type FeatureExtractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<ExtractorOutput>

export interface TransformersEmbeddingOptions {
  /** Hugging Face model id (ONNX-converted). Default Xenova/all-MiniLM-L6-v2. */
  modelId?: string
  /** Pinned model revision (commit SHA or tag). Default pins a specific commit, not the mutable `main`. */
  revision?: string
  /** Output dimension of the model. Default 384; auto-corrected from the first embedding. */
  dimension?: number
  /** Local model directory; when set, no model is fetched at runtime (offline, strict trust boundary). */
  localModelPath?: string
  /** Advanced/testing seam: supply the feature-extraction pipeline instead of loading transformers.js. */
  loadPipeline?: () => Promise<FeatureExtractor>
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'
// Pinned commit of Xenova/all-MiniLM-L6-v2 (resolved from main on 2026-05-30, the verified model).
const DEFAULT_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9'
const DEFAULT_DIM = 384
const MAX_EMBED_CHARS = 100_000

export class TransformersEmbedding implements EmbeddingPort {
  private readonly modelId: string
  private readonly revision: string
  private readonly localModelPath?: string
  private readonly loadPipeline?: () => Promise<FeatureExtractor>
  private dim: number
  private extractorPromise: Promise<FeatureExtractor> | null = null

  constructor(opts: TransformersEmbeddingOptions = {}) {
    this.modelId = opts.modelId ?? DEFAULT_MODEL
    this.revision = opts.revision ?? DEFAULT_REVISION
    this.dim = opts.dimension ?? DEFAULT_DIM
    this.localModelPath = opts.localModelPath
    this.loadPipeline = opts.loadPipeline
  }

  /** Lazily build the pipeline; never importing this module pulls transformers.js or a model. */
  private loadExtractor(): Promise<FeatureExtractor> {
    if (!this.extractorPromise) {
      const factory = this.loadPipeline ?? (() => this.defaultLoadPipeline())
      this.extractorPromise = factory().catch((err: unknown) => {
        // Do not memoize a rejected load: a transient first-load failure must not permanently
        // poison the adapter (AUDIT F). The next call retries from scratch.
        this.extractorPromise = null
        throw err
      })
    }
    return this.extractorPromise
  }

  private async defaultLoadPipeline(): Promise<FeatureExtractor> {
    const tf = await import('@huggingface/transformers')
    // Set the global flag deterministically each load, regardless of construction order (AUDIT F).
    tf.env.allowRemoteModels = !this.localModelPath
    if (this.localModelPath) tf.env.localModelPath = this.localModelPath
    const pipe = await tf.pipeline(
      'feature-extraction',
      this.modelId,
      this.localModelPath ? {} : { revision: this.revision },
    )
    return pipe as unknown as FeatureExtractor
  }

  async embed(text: string): Promise<Float32Array> {
    if (text.length > MAX_EMBED_CHARS) {
      throw new ValidationError(`embed: text exceeds ${MAX_EMBED_CHARS} characters`)
    }
    const extractor = await this.loadExtractor()
    const out = await extractor(text, { pooling: 'mean', normalize: true })
    // Always copy: never hand back a buffer the pipeline may reuse internally (AUDIT F).
    const vec = out.data instanceof Float32Array ? new Float32Array(out.data) : Float32Array.from(out.data)
    this.dim = vec.length // auto-correct the reported dimension from the real model output
    return vec
  }

  dimension(): number {
    return this.dim
  }

  modelHash(): string {
    return this.localModelPath ? `local:${this.modelId}` : `${this.modelId}@${this.revision}`
  }
}
