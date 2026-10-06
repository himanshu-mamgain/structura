import type { AssistReply, AssistRequest } from '@structura/shared'

/**
 * Streams one assistant turn. Calls onSnapshot with the JSON generated so far
 * (for live reply text) and resolves with the validated final reply.
 */
export type Provider = (
  req: AssistRequest,
  onSnapshot: (jsonSoFar: string) => void,
  signal: AbortSignal,
) => Promise<AssistReply>
