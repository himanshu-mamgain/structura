// Runs the WebAssembly simulator off the main thread, so the 3D view keeps
// animating smoothly while a simulation computes.
import init, { simulate } from '@structura/sim'
import wasmUrl from '@structura/sim/wasm?url'

const ready = init({ module_or_path: wasmUrl })

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; config: string }>) => void) | null
  postMessage(message: { id: number; output: string }): void
}

scope.onmessage = async (event) => {
  await ready
  scope.postMessage({ id: event.data.id, output: simulate(event.data.config) })
}
