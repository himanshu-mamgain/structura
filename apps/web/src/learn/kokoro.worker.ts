/// <reference lib="webworker" />
import { KokoroTTS } from 'kokoro-js'

// Kokoro text-to-speech (Apache 2.0) running on the device, off the main
// thread so animations stay smooth while audio is generated. The model
// (~90 MB) downloads once and the browser caches it.

type Request = { type: 'load' } | { type: 'speak'; id: number; text: string; voice: string; speed: number }

let tts: Promise<KokoroTTS> | null = null

function load(): Promise<KokoroTTS> {
  tts ??= (async () => {
    const webgpu = 'gpu' in navigator && Boolean(await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null))
    return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      // WebGPU wants full precision; on the CPU (WASM) the 8-bit model is fast and small.
      dtype: webgpu ? 'fp32' : 'q8',
      device: webgpu ? 'webgpu' : 'wasm',
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx')) postMessage({ type: 'progress', progress: p.progress ?? 0 })
      },
    })
  })()
  return tts
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data
  try {
    const model = await load()
    if (msg.type === 'load') {
      postMessage({ type: 'ready' })
      return
    }
    const audio = await model.generate(msg.text, { voice: msg.voice as never, speed: msg.speed })
    const samples = audio.audio as Float32Array
    postMessage({ type: 'audio', id: msg.id, samples, rate: audio.sampling_rate }, { transfer: [samples.buffer] })
  } catch (error) {
    tts = null
    postMessage({ type: 'error', id: msg.type === 'speak' ? msg.id : -1, message: String(error) })
  }
}
