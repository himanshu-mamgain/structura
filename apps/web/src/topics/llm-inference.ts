import type { Trace } from '@structura/shared'
import { defaultTrace, type Simulator } from './simulator'
import type { StaticTopic } from './types'

// The simulator does the arithmetic a team does before it rents a GPU: how big
// the weights are at each precision, whether they fit, how much room is left for
// the KV cache, how many conversations fit at once, and the fastest the model can
// write tokens, which is set by how quickly the GPU can read its memory.
// Model shapes and parameter counts are from each model's config.json and
// safetensors header on Hugging Face; GPU figures are from NVIDIA's data sheets.

interface ModelSpec {
  name: string
  /** Every weight in the model, from the safetensors header. */
  params: number
  /** The input embedding plus the output layer (152,064 words × hidden size, twice). Quantized files keep them at 16 bits. */
  embedHead: number
  layers: number
  kvHeads: number
  /** Tensor-parallel sizes vLLM accepts: they must divide the number of attention heads. */
  tp: number[]
  license: string
}

const HEAD_DIM = 128 // every Qwen2.5 size: hidden size ÷ attention heads

const MODELS: Record<string, ModelSpec> = {
  'Qwen2.5-7B-Instruct (7.6 billion weights)': { name: 'Qwen2.5-7B-Instruct', params: 7_615_616_512, embedHead: 1_089_994_752, layers: 28, kvHeads: 4, tp: [1, 2, 4], license: 'Apache 2.0' },
  'Qwen2.5-32B-Instruct (32.8 billion)': { name: 'Qwen2.5-32B-Instruct', params: 32_763_876_352, embedHead: 1_557_135_360, layers: 64, kvHeads: 8, tp: [1, 2, 4, 8], license: 'Apache 2.0' },
  'Qwen2.5-72B-Instruct (72.7 billion)': { name: 'Qwen2.5-72B-Instruct', params: 72_706_203_648, embedHead: 2_491_416_576, layers: 80, kvHeads: 8, tp: [1, 2, 4, 8], license: 'Qwen licence' },
}

interface Precision {
  short: string
  /** Bytes for each weight in the big matrices. */
  bytes: number
}

const PRECISIONS: Record<string, Precision> = {
  'BF16 (2 bytes a weight)': { short: 'BF16', bytes: 2 },
  'FP8 (1 byte a weight)': { short: 'FP8', bytes: 1 },
  // 4 bits = half a byte, plus a 16-bit scale and a 4-bit zero point for every group of 128 weights.
  '4-bit AWQ (about half a byte)': { short: '4-bit AWQ', bytes: 0.5 + 2.5 / 128 },
}

interface Gpu {
  name: string
  /** Listed memory in GB. The real cards have slightly more, so results are a little on the safe side. */
  mem: number
  /** Memory bandwidth in GB a second. */
  bw: number
}

const GPUS: Record<string, Gpu> = {
  'NVIDIA L4 (24 GB, 300 GB/s)': { name: 'L4', mem: 24, bw: 300 },
  'RTX 4090 (24 GB, 1,008 GB/s)': { name: 'RTX 4090', mem: 24, bw: 1008 },
  'A100 80GB SXM (2,039 GB/s)': { name: 'A100 80GB', mem: 80, bw: 2039 },
  'H100 SXM (80 GB, 3,350 GB/s)': { name: 'H100 SXM', mem: 80, bw: 3350 },
}

const WORKLOADS: Record<string, { name: string; prompt: number; answer: number }> = {
  'Chat: 1,500 tokens in, 500 out': { name: 'chat', prompt: 1500, answer: 500 },
  'Long document: 15,000 tokens in, 1,000 out': { name: 'long document', prompt: 15_000, answer: 1000 },
}

const USERS: Record<string, number> = { '1 user': 1, '16 users': 16, '64 users': 64 }

/** --gpu-memory-utilization: the share of each GPU the engine may use. */
const UTIL = 0.9
/** GB a GPU we set aside for the engine's working memory (activations, CUDA graphs). vLLM measures the real figure at start-up. */
const WORK_GB = 2
const GB = 1e9

/** Bytes for the whole model at a precision. */
export function weightBytes(m: ModelSpec, p: Precision) {
  return p.bytes === 2 ? m.params * 2 : m.embedHead * 2 + (m.params - m.embedHead) * p.bytes
}

/** Keys and values for one token, in every layer, at 16 bits. */
export const kvBytesPerToken = (m: ModelSpec) => 2 * m.layers * m.kvHeads * HEAD_DIM * 2

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const gb = (bytes: number) => (bytes < GB ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / GB).toFixed(2)} GB`)
const ms = (s: number) => `${(s * 1000).toFixed(1)} ms`
const sec = (s: number) => (s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`)

function plan(values: Record<string, string>) {
  const m = MODELS[values.model] ?? Object.values(MODELS)[0]
  const p = PRECISIONS[values.precision] ?? Object.values(PRECISIONS)[0]
  const g = GPUS[values.gpu] ?? Object.values(GPUS)[0]
  const w = WORKLOADS[values.workload] ?? Object.values(WORKLOADS)[0]
  const users = USERS[values.users] ?? 16

  const weights = weightBytes(m, p)
  const kvTok = kvBytesPerToken(m)
  const perConversation = (w.prompt + w.answer) * kvTok
  const usablePerGpu = (g.mem * UTIL - WORK_GB) * GB
  // The fewest GPUs that hold the weights and at least one whole conversation.
  const gpus = m.tp.find((n) => n * usablePerGpu - weights >= perConversation) ?? 0
  const n = gpus || m.tp[m.tp.length - 1]
  const kvSpace = Math.max(0, n * usablePerGpu - weights)
  const tokensFit = Math.floor(kvSpace / kvTok)
  const slots = Math.floor(tokensFit / (w.prompt + w.answer))
  const active = Math.min(users, slots)
  const waiting = users - active
  // Every decode step reads all the weights once, plus each running conversation's
  // keys and values so far (on average, the prompt and half the answer).
  const kvRead = active * (w.prompt + w.answer / 2) * kvTok
  const step = (weights + kvRead) / (n * g.bw * GB)
  return { m, p, g, w, users, weights, kvTok, perConversation, usablePerGpu, gpus, n, kvSpace, tokensFit, slots, active, waiting, kvRead, step }
}

const simulator: Simulator = {
  fields: [
    { id: 'model', label: 'Model', options: Object.keys(MODELS) },
    { id: 'precision', label: 'Precision', options: Object.keys(PRECISIONS) },
    { id: 'gpu', label: 'GPU', options: Object.keys(GPUS) },
    { id: 'workload', label: 'Each conversation', options: Object.keys(WORKLOADS) },
    { id: 'users', label: 'Users at once', options: Object.keys(USERS) },
  ],
  defaults: {
    model: 'Qwen2.5-7B-Instruct (7.6 billion weights)',
    precision: 'BF16 (2 bytes a weight)',
    gpu: 'NVIDIA L4 (24 GB, 300 GB/s)',
    workload: 'Chat: 1,500 tokens in, 500 out',
    users: '16 users',
  },
  run(values) {
    const r = plan(values)
    const { m, p, g, w } = r
    const steps: Trace['steps'] = []
    const many = r.n > 1 ? `${r.n} × ${g.name}` : `one ${g.name}`

    steps.push({
      text: `${m.name} is ${int(m.params)} weights: numbers learned in training, stored in safetensors files in the Model Registry. At ${p.short}, the Weights Loader has ${gb(r.weights)} to download and copy into GPU memory.${p.bytes < 2 ? ' The big matrices shrink; the input and output layers stay at 16 bits.' : ''}`,
      nodes: ['Model Registry', 'Weights Loader'],
      data: [
        `${int(m.params)} weights, licence: ${m.license}`,
        ...Object.values(PRECISIONS).map((x) => `${x.short.padEnd(10)} ${gb(weightBytes(m, x)).padStart(10)}${x === p ? '   ← chosen' : ''}`),
        `download at 1 Gbit/s (125 MB/s): ${sec(r.weights / 125e6)}`,
      ].join('\n'),
    })

    steps.push({
      text: r.gpus
        ? `The engine may use ${UTIL * 100}% of each GPU and keeps ${WORK_GB} GB for its working memory. ${r.n > 1 ? `One ${g.name} is too small, so the weights are split across ${r.n} GPUs (tensor parallelism): each holds 1/${r.n} of every matrix.` : `The weights fit on one ${g.name}.`} What is left becomes the KV cache.`
        : `Even ${r.n} × ${g.name} can't hold the weights and one conversation. Pick a smaller model, a lower precision or a bigger GPU.`,
      nodes: ['Weights Loader', 'Model Weights'],
      data: [
        `${many}: ${r.n} × (${g.mem} GB × ${UTIL} − ${WORK_GB} GB) = ${gb(r.n * r.usablePerGpu)}`,
        `− weights               ${gb(r.weights)}`,
        `= KV cache space        ${gb(r.kvSpace)}`,
      ].join('\n'),
    })

    steps.push({
      text: `For every token it has seen, the model keeps a key and a value in every layer, so it never has to work them out again. That is the KV cache. ${m.name} needs ${int(r.kvTok)} bytes a token, so ${gb(r.kvSpace)} holds ${int(r.tokensFit)} tokens: ${int(r.slots)} ${w.name} conversation${r.slots === 1 ? '' : 's'} of ${int(w.prompt + w.answer)} tokens at once.`,
      nodes: ['KV Cache'],
      data: [
        `2 (key and value) × ${m.layers} layers × ${m.kvHeads} KV heads × ${HEAD_DIM} numbers × 2 bytes`,
        `= ${int(r.kvTok)} bytes a token (${(r.kvTok / 1024).toFixed(0)} KB)`,
        `one ${w.name}: ${int(w.prompt + w.answer)} tokens × ${int(r.kvTok)} = ${gb(r.perConversation)}`,
        `${gb(r.kvSpace)} ÷ ${int(r.kvTok)} = ${int(r.tokensFit)} tokens = ${int(r.slots)} at once`,
      ].join('\n'),
    })

    steps.push({
      text: `${r.users === 1 ? 'A user sends' : `${r.users} users send`} a request to the Inference API, which speaks the same API as OpenAI's. The Tokenizer splits each prompt into ${int(w.prompt)} tokens: word pieces, about three quarters of a word each.`,
      nodes: ['Chat App', 'Inference API', 'Tokenizer'],
      data: JSON.stringify({ model: m.name, stream: true, max_tokens: w.answer, messages: [{ role: 'user', content: w.prompt > 5000 ? '<a 11,000-word contract> Summarise the risks.' : '<1,100 words of chat history> What should I do next?' }] }, null, 2),
    })

    steps.push({
      text: r.waiting
        ? `The Batch Scheduler asks: does the KV cache have room? Only ${int(r.active)} conversations fit, so ${int(r.waiting)} of ${int(r.users)} wait in Waiting Requests. A place frees up only when an answer finishes, after about ${sec(w.answer * r.step)}.`
        : `The Batch Scheduler asks: does the KV cache have room? Yes: all ${int(r.users)} fit (room for ${int(r.slots)}), so they run together in one batch. Continuous batching adds a new request the moment another one finishes.`,
      nodes: ['Waiting Requests', 'Batch Scheduler', 'KV Cache Has Room?'],
      data: [
        `users now: ${int(r.users)}`,
        `room for:  ${int(r.slots)}`,
        `running:   ${int(r.active)}`,
        `waiting:   ${int(r.waiting)}`,
      ].join('\n'),
    })

    steps.push({
      text: `Prefill runs all ${int(w.prompt)} prompt tokens through the model in one pass, in parallel, and writes their keys and values into the KV Cache. This part is limited by the GPU's arithmetic, so it is quick for each token. Then it picks the first answer token.`,
      nodes: ['Prefill', 'Model Weights', 'KV Cache'],
      data: `${int(w.prompt)} tokens × ${int(r.kvTok)} bytes = ${gb(w.prompt * r.kvTok)} written to the KV cache`,
    })

    steps.push({
      text: `The Decode Loop writes one token per step for every running conversation. Each step must read all ${gb(r.weights)} of weights, plus every conversation's cache, from GPU memory. So memory speed, not arithmetic, sets the pace: at best one step every ${ms(r.step)}.`,
      nodes: ['Decode Loop', 'Model Weights', 'KV Cache'],
      data: [
        `read each step: ${gb(r.weights)} weights + ${gb(r.kvRead)} cache`,
        `÷ ${r.n > 1 ? `(${r.n} × ${int(g.bw)} GB/s)` : `${int(g.bw)} GB/s`} = ${ms(r.step)} a step`,
        `each user: ≤ ${(1 / r.step).toFixed(1)} tokens a second`,
        `all users: ≤ ${int(r.active / r.step)} tokens a second`,
      ].join('\n'),
    })

    steps.push({
      text: `The Detokenizer turns token ids back into text, and the Inference API streams each piece to the Chat App as it is made. A ${int(w.answer)}-token answer takes at least ${sec(w.answer * r.step)}.${r.step > 0.05 ? ' That is slow: try 4-bit, or a GPU with faster memory.' : ''}`,
      nodes: ['Detokenizer', 'Inference API', 'Chat App'],
      data: [
        `${int(w.answer)} tokens × ${ms(r.step)} = ${sec(w.answer * r.step)} for the full answer`,
        `upper bound: it ignores prefill, GPU-to-GPU traffic and scheduling`,
      ].join('\n'),
    })

    return {
      input: `${m.name.replace('-Instruct', '')} · ${p.short} · ${many} · ${int(r.users)} × ${w.name} → ${int(r.slots)} fit, ≤ ${(1 / r.step).toFixed(0)} tokens/s each`,
      steps,
    }
  },
}

export const llmInference: StaticTopic = {
  kind: 'static',
  difficulty: 'Advanced',
  id: 'llm-inference',
  title: 'Model Weights & LLM Inference',
  blurb: 'What model weights are, how much GPU memory a model needs, quantization, the KV cache and serving your own model with vLLM',
  guides: ['how-does-chatgpt-work', 'the-open-source-ai-stack', 'scale-scaling-aiml-infrastructure-at-uber', 'scale-distributed-machine-learning'],
  takeaways: [
    'A model\'s weights are the numbers it learned in training; "7B" means 7 billion of them, and each takes 2 bytes at BF16, so 7.6 billion weights need 15.2 GB.',
    'Quantization stores each weight in fewer bits: 4-bit makes a model about a third of its BF16 size, with a small loss of quality you should measure on your own tests.',
    'GPU memory holds the weights and the KV cache; whatever the weights leave decides how many conversations can run at once.',
    'The KV cache costs 2 × layers × KV heads × head size × 2 bytes for every token, so long prompts eat memory fast.',
    'Writing tokens is limited by memory bandwidth: every step reads all the weights, so smaller weights and faster memory mean faster answers.',
    'Serve open-weight models with an engine such as vLLM, which batches many users together and pages the KV cache so no memory is wasted.',
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'server', label: 'Inference server' },
      { id: 'engine', label: 'Engine' },
      { id: 'gpu', label: 'GPU memory' },
      { id: 'store', label: 'Model files' },
    ],
    nodes: [
      { id: 'app', label: 'Chat App', shape: 'ellipse', color: 'blue', group: null },
      { id: 'api', label: 'Inference API', shape: 'rectangle', color: 'violet', group: 'server' },
      { id: 'tok', label: 'Tokenizer', shape: 'rectangle', color: 'violet', group: 'server' },
      { id: 'detok', label: 'Detokenizer', shape: 'rectangle', color: 'violet', group: 'server' },
      { id: 'queue', label: 'Waiting Requests', shape: 'rectangle', color: 'yellow', group: 'engine' },
      { id: 'sched', label: 'Batch Scheduler', shape: 'rectangle', color: 'violet', group: 'engine' },
      { id: 'room', label: 'KV Cache Has Room?', shape: 'diamond', color: 'violet', group: 'engine' },
      { id: 'prefill', label: 'Prefill', shape: 'rectangle', color: 'orange', group: 'engine' },
      { id: 'decode', label: 'Decode Loop', shape: 'rectangle', color: 'orange', group: 'engine' },
      { id: 'weights', label: 'Model Weights', shape: 'rectangle', color: 'green', group: 'gpu' },
      { id: 'kv', label: 'KV Cache', shape: 'rectangle', color: 'red', group: 'gpu' },
      { id: 'registry', label: 'Model Registry', shape: 'rectangle', color: 'green', group: 'store' },
      { id: 'loader', label: 'Weights Loader', shape: 'rectangle', color: 'orange', group: 'store' },
    ],
    edges: [
      { from: 'app', to: 'api', label: 'prompt', dashed: false },
      { from: 'api', to: 'tok', label: 'text', dashed: false },
      { from: 'tok', to: 'queue', label: 'token ids', dashed: false },
      { from: 'queue', to: 'sched', label: 'next requests', dashed: false },
      { from: 'sched', to: 'room', label: 'admit?', dashed: false },
      { from: 'room', to: 'prefill', label: 'yes: reserve blocks', dashed: false },
      { from: 'room', to: 'queue', label: 'no: wait', dashed: true },
      { from: 'prefill', to: 'kv', label: 'prompt keys, values', dashed: false },
      { from: 'prefill', to: 'decode', label: 'first token', dashed: false },
      { from: 'decode', to: 'kv', label: 'read all, add one', dashed: false },
      { from: 'weights', to: 'prefill', label: 'read', dashed: true },
      { from: 'weights', to: 'decode', label: 'read every step', dashed: true },
      { from: 'decode', to: 'detok', label: 'token ids', dashed: false },
      { from: 'detok', to: 'api', label: 'text pieces', dashed: false },
      { from: 'api', to: 'app', label: 'stream', dashed: true },
      { from: 'registry', to: 'loader', label: 'safetensors files', dashed: false },
      { from: 'loader', to: 'weights', label: 'copy to GPU', dashed: false },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'models',
        name: 'models',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'base_model_id', type: 'uuid', pk: false, fk: 'models.id', nullable: true, unique: false },
          { name: 'parameters', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'layers', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'kv_heads', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'context_length', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'license', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'model_files',
        name: 'model_files',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'model_id', type: 'uuid', pk: false, fk: 'models.id', nullable: false, unique: false },
          { name: 'precision', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'format', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'size_bytes', type: 'bigint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'sha256', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'uri', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'eval_score', type: 'numeric(5,2)', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: ['(model_id, precision)'],
      },
      {
        id: 'deployments',
        name: 'deployments',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'model_file_id', type: 'uuid', pk: false, fk: 'model_files.id', nullable: false, unique: false },
          { name: 'gpu_type', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'gpus_per_replica', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'replicas', type: 'smallint', pk: false, fk: null, nullable: false, unique: false },
          { name: 'max_model_len', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'gpu_memory_utilization', type: 'numeric(3,2)', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(model_file_id)'],
      },
      {
        id: 'inference_log',
        name: 'inference_log',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'deployment_id', type: 'uuid', pk: false, fk: 'deployments.id', nullable: false, unique: false },
          { name: 'prompt_tokens', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'output_tokens', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'queue_ms', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'first_token_ms', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'total_ms', type: 'int', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(deployment_id, created_at)'],
      },
    ],
    relations: [
      { from: 'models', to: 'model_files', kind: 'one-to-many', label: 'stored as' },
      { from: 'model_files', to: 'deployments', kind: 'one-to-many', label: 'served by' },
      { from: 'deployments', to: 'inference_log', kind: 'one-to-many', label: 'logs' },
    ],
  },
  explanation: {
    title: 'Model Weights & LLM Inference',
    summary:
      'A large language model is a file of numbers called weights, learned in training. Running it, called inference, means loading those weights into GPU memory and passing your tokens through them. The weights\' size decides which GPU you need; whatever memory is left holds the KV cache, which decides how many conversations run at once; and because every new token reads all the weights, memory speed decides how fast answers come.',
    sections: [
      {
        heading: 'Overview',
        body: 'A large language model (LLM) is a neural network: layers of matrices filled with numbers. Each number is a weight (also called a parameter). Training sets the weights by showing the model a huge amount of text. After that they are fixed, and the model is just a file. "Qwen2.5-7B" means about 7 billion weights; Qwen2.5-7B-Instruct has exactly 7,615,616,512.\n\nAn open-weight model is one whose weight files you can download and run on your own GPUs, such as Qwen, Llama, Mistral or GRM-2.6-Plus (OrionLLM\'s fine-tune of Qwen3.6-27B). A closed model, such as the ones behind ChatGPT or Claude, is only reachable through its maker\'s API.\n\nInference has two parts. Prefill reads the whole prompt in one parallel pass. Decode then writes the answer one token at a time, and every step reads all the weights from GPU memory. The simulator does this arithmetic for real Qwen2.5 models on four real GPUs.',
      },
      {
        heading: 'Requirements',
        body: 'Functional:\n- Serve an open-weight chat model behind an OpenAI-compatible API, with streaming.\n- Run many conversations at once on each GPU.\n- Load a new model version without downtime, and roll back.\n- Log prompt and answer token counts, queue time, time to first token and total time.\n\nNon-functional:\n- First token in under 1 second; then at least 20 tokens a second for each user.\n- Keep data in your own network: no prompts sent to an outside provider.\n- Keep GPUs busy: they are the biggest cost, and you pay by the hour whether they work or not.',
      },
      {
        heading: 'Capacity estimates',
        body: '- Weights: 7,615,616,512 × 2 bytes = 15.23 GB at BF16; 8.71 GB at FP8; 5.57 GB at 4-bit AWQ (the real Qwen2.5-7B-Instruct-AWQ files are 5,570,829,760 bytes).\n- Room on one 24 GB L4: 24 × 0.9 − 2 GB working memory = 19.6 GB; minus 15.23 GB of weights leaves 4.37 GB.\n- KV cache: 2 × 28 layers × 4 KV heads × 128 × 2 bytes = 57,344 bytes a token, so 4.37 GB holds 76,185 tokens: 38 chats of 2,000 tokens at once.\n- Speed: each decode step reads 15.23 GB of weights and about 1.61 GB of cache for 16 users. 16.84 GB ÷ 300 GB/s = 56 ms a step: at most 17.8 tokens a second each, 285 in total.\n- Same model at 4-bit: (5.57 + 1.61) GB ÷ 300 GB/s = 24 ms a step, 41.8 tokens a second each.\n- 72B at BF16 is 145.41 GB: it needs 4 H100s working together; at 4-bit (41.46 GB) it fits on one.',
      },
      {
        heading: 'Step by step',
        body: '1. The Model Registry stores each model\'s weight files (safetensors) with their size and SHA-256 hash.\n2. The Weights Loader downloads the files, checks the hash and copies the weights into Model Weights in GPU memory.\n3. The rest of the GPU memory the engine may use becomes the KV Cache, split into small blocks (16 tokens each, for example).\n4. The Chat App sends a request to the Inference API, which streams the answer back.\n5. The Tokenizer turns the prompt into token ids; the request joins Waiting Requests.\n6. The Batch Scheduler picks requests; KV Cache Has Room? reserves blocks for each, or leaves it waiting.\n7. Prefill runs the whole prompt through the Model Weights at once and writes its keys and values into the KV Cache.\n8. The Decode Loop makes one token per step for every running request, reading the Model Weights and the KV Cache each time.\n9. The Detokenizer turns token ids into text, and the Inference API streams it to the Chat App.',
      },
      {
        heading: 'Components',
        body: '- Chat App: the product the user types into; it calls the API like any hosted model.\n- Inference API: an OpenAI-compatible HTTP server (/v1/chat/completions) that streams tokens back as server-sent events.\n- Tokenizer: splits text into token ids from the model\'s fixed vocabulary (about 151,000 word pieces for Qwen2.5).\n- Detokenizer: turns token ids back into text, a few characters at a time.\n- Waiting Requests: requests accepted but not yet running, because the KV cache is full.\n- Batch Scheduler: continuous batching: adds a request to the running batch the moment another finishes.\n- KV Cache Has Room?: admits a request only when there are free KV cache blocks for it.\n- Prefill: processes the whole prompt in one parallel pass; limited by the GPU\'s arithmetic.\n- Decode Loop: writes one token per step for every running request; limited by memory bandwidth.\n- Model Weights: the model\'s matrices in GPU memory, read on every step.\n- KV Cache: the keys and values of every token so far, stored in fixed-size blocks (paged attention).\n- Model Registry: the weight files for each model and precision, with hashes and evaluation scores.\n- Weights Loader: downloads, checks and loads weights into the GPU when a server starts.',
      },
      {
        heading: 'Key decisions',
        body: '- API or your own GPUs: a hosted API is cheaper at low traffic and needs no GPU team. Your own model keeps data in-house, can be fine-tuned, and is cheaper once GPUs stay busy.\n- Model size: the smallest model that passes your own tests. A 7B model is fast and cheap; a 72B model reasons better and needs 4 to 8 times the memory.\n- Precision: BF16 is the reference. FP8 halves the size with little loss on recent GPUs. 4-bit (AWQ, GPTQ or GGUF) is about a third of BF16 and runs on small cards, with more loss on hard tasks. Measure it on your own test set.\n- Context length: set --max-model-len to what you need. A 128K context lets one request take the whole KV cache.\n- One big GPU or several small ones: splitting a model across GPUs (tensor parallelism) adds GPU-to-GPU traffic. Prefer the fewest GPUs that fit; add whole replicas for more users.\n- Engine: vLLM, SGLang or TensorRT-LLM on servers; llama.cpp or Ollama on a laptop.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Scale out with replicas: each replica is one full copy of the model on its own GPUs, behind a load balancer that routes on queue length, not round robin.\n- Cold starts are slow: a replica must download and load the weights (15.23 GB at 125 MB/s is about 2 minutes). Keep files on local disk or a fast cache, and keep warm replicas.\n- A full KV cache makes requests wait, not fail. Watch queue time and KV cache use, and scale before both climb.\n- One very long prompt can push others out. Cap max_tokens and --max-model-len, and keep long jobs on their own replicas.\n- GPUs fail and run out of memory (OOM). Health-check with a real tiny prompt, and restart a replica that stops making tokens.\n- A new model or precision can be worse in ways you don\'t expect. Roll it out to a few percent of traffic first and compare evaluation scores.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- How much GPU memory does a 70B model need at 16 bits, and at 4 bits?\n- Why is decoding limited by memory bandwidth and prefill by compute?\n- What is the KV cache, and how does its size grow with context and users?\n- How does continuous batching beat waiting for a full batch?\n- What is paged attention, and what waste does it remove?\n- When would you split a model across GPUs, and what does it cost?\n- How do you check that a quantized model is still good enough?',
      },
    ],
    get trace() {
      return defaultTrace(simulator)
    },
    code: [
      {
        title: 'Will it fit? Weights, KV cache and speed',
        language: 'javascript',
        source: `// Rough sizing for one GPU, before you rent it. Shapes come from the model's config.json.
const model = { params: 7_615_616_512, layers: 28, kvHeads: 4, headDim: 128 } // Qwen2.5-7B
const gpu = { memGB: 24, bandwidthGBs: 300 } // NVIDIA L4

const weightsGB = (model.params * 2) / 1e9 // BF16: 2 bytes a weight
const kvPerToken = 2 * model.layers * model.kvHeads * model.headDim * 2 // key + value, 2 bytes each
const kvSpaceGB = gpu.memGB * 0.9 - 2 - weightsGB // 90% of memory, minus 2 GB working memory

const tokensFit = Math.floor((kvSpaceGB * 1e9) / kvPerToken)
const chatsFit = Math.floor(tokensFit / 2000) // 1,500 in + 500 out
// Every decode step reads all the weights, so this is the best case for one user.
const tokensPerSecond = gpu.bandwidthGBs / weightsGB

console.log(weightsGB.toFixed(2), 'GB of weights')          // 15.23
console.log(kvPerToken, 'bytes of KV cache a token')        // 57344
console.log(tokensFit, 'tokens fit;', chatsFit, 'chats')    // 76185 tokens; 38 chats
console.log(tokensPerSecond.toFixed(1), 'tokens/s at best') // 19.7`,
        versions: [
          {
            language: 'java',
            source: `public class WillItFit {
  public static void main(String[] args) {
    // Qwen2.5-7B, from its config.json; an NVIDIA L4 GPU.
    long params = 7_615_616_512L;
    int layers = 28, kvHeads = 4, headDim = 128;
    double memGB = 24, bandwidthGBs = 300;

    double weightsGB = params * 2 / 1e9; // BF16: 2 bytes a weight
    long kvPerToken = 2L * layers * kvHeads * headDim * 2; // key + value, 2 bytes each
    double kvSpaceGB = memGB * 0.9 - 2 - weightsGB; // 90% of memory, minus 2 GB working memory

    long tokensFit = (long) Math.floor(kvSpaceGB * 1e9 / kvPerToken);
    long chatsFit = tokensFit / 2000; // 1,500 in + 500 out
    // Every decode step reads all the weights, so this is the best case for one user.
    double tokensPerSecond = bandwidthGBs / weightsGB;

    System.out.printf("%.2f GB of weights%n", weightsGB);           // 15.23
    System.out.println(kvPerToken + " bytes of KV cache a token");  // 57344
    System.out.println(tokensFit + " tokens fit; " + chatsFit + " chats"); // 76185; 38
    System.out.printf("%.1f tokens/s at best%n", tokensPerSecond);  // 19.7
  }
}`,
          },
          {
            language: 'python',
            source: `# Qwen2.5-7B, from its config.json; an NVIDIA L4 GPU.
params, layers, kv_heads, head_dim = 7_615_616_512, 28, 4, 128
mem_gb, bandwidth_gbs = 24, 300

weights_gb = params * 2 / 1e9                       # BF16: 2 bytes a weight
kv_per_token = 2 * layers * kv_heads * head_dim * 2 # key + value, 2 bytes each
kv_space_gb = mem_gb * 0.9 - 2 - weights_gb         # 90% of memory, minus 2 GB working memory

tokens_fit = int(kv_space_gb * 1e9 // kv_per_token)
chats_fit = tokens_fit // 2000                      # 1,500 in + 500 out
tokens_per_second = bandwidth_gbs / weights_gb      # every step reads all the weights

print(f"{weights_gb:.2f} GB of weights")            # 15.23
print(kv_per_token, "bytes of KV cache a token")    # 57344
print(tokens_fit, "tokens fit;", chats_fit, "chats")  # 76185 tokens; 38 chats
print(f"{tokens_per_second:.1f} tokens/s at best")  # 19.7`,
          },
        ],
      },
      {
        title: 'Serve a model with vLLM (bash)',
        language: 'bash',
        source: `# Install vLLM (Linux, NVIDIA GPU) and serve the 4-bit model on one GPU.
pip install vllm
vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ \\
  --max-model-len 8192 \\
  --gpu-memory-utilization 0.9
# It downloads the 5.57 GB of weights, logs how much KV cache it got,
# and listens on port 8000 with an OpenAI-compatible API.

curl http://localhost:8000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
        "model": "Qwen/Qwen2.5-7B-Instruct-AWQ",
        "max_tokens": 200,
        "messages": [{"role": "user", "content": "What is a KV cache, in one sentence?"}]
      }'`,
      },
      {
        title: 'Stream the answer from your own server',
        language: 'javascript',
        source: `// The server speaks OpenAI's API, so the client is the same as for a hosted model.
// With stream: true, each server-sent event carries a few new characters.
const res = await fetch('http://localhost:8000/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
    stream: true,
    max_tokens: 200,
    messages: [{ role: 'user', content: 'Explain quantization to a new engineer.' }],
  }),
})

const decoder = new TextDecoder()
let buffer = ''
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true })
  const lines = buffer.split('\\n')
  buffer = lines.pop() // keep a half-received line for the next chunk
  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    const delta = JSON.parse(line.slice(6)).choices[0].delta.content
    if (delta) process.stdout.write(delta)
  }
}`,
        versions: [
          {
            language: 'java',
            source: `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class StreamAnswer {
  public static void main(String[] args) throws Exception {
    // The server speaks OpenAI's API, so the request is the same as for a hosted model.
    String body = """
        {"model": "Qwen/Qwen2.5-7B-Instruct-AWQ", "stream": true, "max_tokens": 200,
         "messages": [{"role": "user", "content": "Explain quantization to a new engineer."}]}""";
    HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:8000/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build();

    // ofLines() hands over each server-sent event line as it arrives.
    HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofLines()).body()
        .filter(line -> line.startsWith("data: ") && !line.equals("data: [DONE]"))
        .forEach(line -> System.out.println(line.substring(6))); // one JSON chunk with a few new characters
  }
}`,
          },
        ],
      },
    ],
    related: ['LLM gateway', 'LLM guardrails', 'RAG pipeline', 'Load balancer', 'Autoscaling', 'Caching'],
  },
  simulator,
}
