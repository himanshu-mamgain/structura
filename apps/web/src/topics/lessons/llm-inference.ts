import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'A model is a file of numbers',
      text: 'A large language model is layers of big grids of numbers. Each number is a weight, learned in training. After training the weights never change, so the model is just a file. "7B" means about 7 billion weights.',
      focus: ['Model Registry'],
      example: 'Qwen2.5-7B-Instruct: 7,615,616,512 weights',
      remember: 'Weights are what the model learned. Inference is using them.',
    },
    {
      title: 'Size = weights × bytes',
      text: 'In BF16, a 16-bit number format, each weight takes 2 bytes. So the 7B model needs 15.23 GB just for its weights. The Weights Loader copies them into the GPU, the chip that does the maths.',
      focus: ['Weights Loader', 'Model Weights'],
      example: '7,615,616,512 × 2 bytes = 15.23 GB',
    },
    {
      title: 'Quantization: fewer bits',
      text: 'Quantization stores each weight with fewer bits, like rounding prices to the nearest 10 rupees. At 4 bits the same model is 5.57 GB, about a third of its BF16 size. You lose a little quality, so test it on your own questions.',
      focus: ['Model Weights'],
      example: 'BF16 15.23 GB → FP8 8.71 GB → 4-bit 5.57 GB',
    },
    {
      title: 'Tokens in',
      text: 'The Tokenizer splits your text into tokens: pieces of words, about three quarters of a word each. The model only ever sees token ids. The Detokenizer turns the ids it writes back into text.',
      focus: ['Chat App', 'Inference API', 'Tokenizer', 'Detokenizer'],
      example: '"Unbelievable" → "Un" + "believ" + "able"',
    },
    {
      title: 'Prefill: the whole prompt at once',
      text: 'Prefill runs every prompt token through the model in one parallel pass. It is limited by the GPU\'s arithmetic, so it is quick. It ends by picking the first token of the answer.',
      focus: ['Prefill', 'Model Weights'],
      example: '1,500 tokens on an H100: about 23 ms at best',
    },
    {
      title: 'The KV cache',
      text: 'For every token so far, each layer keeps a key and a value, so it never works them out again. This store is the KV cache. It lives in the GPU memory the weights leave free, and it decides how many conversations fit at once.',
      focus: ['KV Cache', 'KV Cache Has Room?'],
      example: '2 × 28 layers × 4 heads × 128 × 2 bytes = 57,344 bytes a token',
      remember: 'Free memory after the weights = how many users fit.',
    },
    {
      title: 'Decode: one token per step',
      text: 'The answer is written one token per step, and every step reads all the weights from memory. Reading 15.23 GB takes far longer than the maths. So memory speed, not arithmetic, decides how fast the answer comes.',
      focus: ['Decode Loop', 'Model Weights', 'KV Cache'],
      example: 'L4: 15.23 GB ÷ 300 GB/s = 51 ms a token, about 20 tokens a second',
    },
    {
      title: 'Batching shares the reading',
      text: 'One read of the weights can serve every waiting user at once. The Batch Scheduler runs them together, and adds a new request the moment another finishes. This is continuous batching. Requests wait only when the KV cache is full.',
      focus: ['Waiting Requests', 'Batch Scheduler', 'KV Cache Has Room?'],
      remember: '16 users cost little more than 1, until the cache is full.',
    },
    {
      title: 'Serve it with vLLM',
      text: 'vLLM is an open-source engine that does all of this: batching, a paged KV cache, quantized weights and splitting across GPUs. It gives you an API that looks like OpenAI\'s, so apps call it like a hosted model.',
      focus: ['Inference API'],
      example: 'vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ --max-model-len 8192',
    },
  ],
  quiz: [
    {
      question: 'A model has 32 billion weights. Roughly how much memory do the weights need at BF16 (2 bytes a weight)?',
      options: ['16 GB', '32 GB', '64 GB', '128 GB'],
      answer: 2,
      why: '32 billion × 2 bytes = 64 GB. At 4 bits it would be about a quarter of that, plus a little extra for layers kept at 16 bits.',
    },
    {
      question: 'Answers come out slowly, one token at a time. What mostly limits the speed of each token?',
      options: ['How fast the GPU can read its memory', 'How fast the GPU can multiply', 'The network between the app and the server', 'The tokenizer'],
      answer: 0,
      why: 'Every decode step reads all the weights from memory but does little maths with them. Smaller weights or faster memory make each step quicker.',
    },
    {
      question: 'The weights fit on your GPU, but only 3 users can chat at once. What is full?',
      options: ['The Model Registry', 'The tokenizer\'s list of words', 'The disk', 'The KV cache'],
      answer: 3,
      why: 'Each conversation keeps keys and values for every token in the KV cache. Shorter maximum lengths, 4-bit weights or a bigger GPU leave room for more.',
    },
  ],
}

export default lesson
