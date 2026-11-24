# Model Weights & LLM Inference

> 💡 **TL;DR**: A large language model (LLM) is a file of numbers called **weights**, learned in training. "7B" means about 7 billion of them. **Inference** means running the model: you load the weights into a GPU (graphics processing unit: the chip that does AI maths fast) and pass your words through them. Three things decide what you need. The **weights' size** decides which GPU: 7.6 billion weights at 2 bytes each are 15.23 GB. **Quantization** stores each weight in fewer bits, so the same model fits in about a third of the memory. The memory left over holds the **KV cache** (key-value cache: what the model remembers about every token so far), and that decides how many conversations run at once. Finally, every new token reads all the weights from memory, so **memory speed** decides how fast answers come.

## At a glance

| Term | What it is | Example |
|---|---|---|
| Weight | One number the model learned in training | Qwen2.5-7B-Instruct has 7,615,616,512 |
| Token | A piece of a word; the unit a model reads and writes | about ¾ of an English word |
| BF16 | 16-bit numbers: 2 bytes a weight | 7.6 billion weights × 2 = 15.23 GB |
| Quantization | Storing weights in fewer bits | 4-bit: the same model in 5.57 GB |
| KV cache | Keys and values for every token so far, kept in GPU memory | 57,344 bytes a token for Qwen2.5-7B |
| Prefill | Reading the whole prompt in one parallel pass | limited by the GPU's arithmetic |
| Decode | Writing the answer, one token per step | limited by how fast memory can be read |
| vLLM | An open-source engine that serves models to many users at once | `vllm serve Qwen/Qwen2.5-7B-Instruct` |

## What model weights are

A **neural network** is a stack of layers. Each layer multiplies the numbers that come in by big grids of numbers called **matrices**, and passes the result on. Every number in those matrices is a **weight**, also called a **parameter**.

**Training** sets the weights. The model reads a huge amount of text and guesses the next word, again and again. After each guess, every weight is nudged a tiny amount so the right word becomes a little more likely. After training, the weights don't change any more. The model is now just a file.

That file is what people mean by "the model":

- **Qwen2.5-7B-Instruct** has exactly 7,615,616,512 weights, so it is called "7B" (7 billion). "Instruct" means it was trained further to follow instructions and chat.
- The weights come in **safetensors** files: a simple format that holds only the matrices, with no code inside, so loading one can't run anything harmful.
- A small `config.json` describes the shape: 28 layers, a hidden size of 3,584 numbers for each token, 28 attention heads and 4 key-value heads.

Where does 15.23 GB come from? In **BF16** (bfloat16: a 16-bit number format made for AI), each weight takes 2 bytes. So 7,615,616,512 × 2 = 15,231,233,024 bytes = 15.23 GB. (We count a GB as a billion bytes.)

### Open weights and closed models

An **open-weight** model is one whose weight files you can download and run on your own GPUs: Qwen, Llama, Mistral, DeepSeek and many more on Hugging Face (a website that hosts model files). A **closed** model, such as the ones behind ChatGPT or Claude, is only reachable through its maker's API: you never see the weights.

Open weights can also be changed. **Fine-tuning** means training an existing model a little more on your own examples. For example, **GRM-2.6-Plus** by OrionLLM is a fine-tune of Qwen3.6-27B, a 27-billion-weight model, for reasoning, coding and agent tasks. It is released under Apache 2.0, a licence that allows commercial use. At BF16 it needs about 27 × 2 = 54 GB; at 4 bits, about 14 GB.

Read the licence before you ship. Qwen2.5-7B and 32B use Apache 2.0. Qwen2.5-72B uses Qwen's own licence, with extra terms for very large products.

> 💡 A **generative reward model** (GRM) is something different: a model that reads another model's answer and judges it. That idea is in [LLM Guardrails](/?topic=llm-guardrails&read).

## How inference works underneath

Inference has three parts: split the text into tokens, read the prompt, then write the answer one token at a time.

1. **Tokenize.** The tokenizer splits your text into **tokens**, pieces of words, and turns each into an id from a fixed list (about 151,000 pieces for Qwen2.5). "Unbelievable" might become "Un", "believ", "able". On average a token is about three quarters of an English word.
2. **Prefill.** The model turns each token into a list of 3,584 numbers and passes all the prompt's tokens through the 28 layers **at the same time**. Each layer mostly multiplies by its weight matrices. At the end, the model scores every token in its list and picks the next one.
3. **Decode.** Now it must write the answer. Each new token depends on the one before, so this part goes **one token per step**. Every step passes one token through all 28 layers again.

### Why decode is slow: memory, not maths

Running one token through the model takes about **2 operations per weight** (one multiply and one add). So for Qwen2.5-7B:

- one token = 2 × 7,615,616,512 ≈ 15.23 billion operations;
- reading all the weights once = 15.23 GB.

An H100 (Nvidia's main data-centre GPU) can do about 990 trillion BF16 operations a second. That is half the 1,979 trillion on its data sheet, which assumes a trick called sparsity that most models don't use. It reads its memory at 3,350 GB a second.

| One decode step, one user, Qwen2.5-7B on an H100 | Time |
|---|---|
| The maths: 15.23 billion ÷ 990 trillion a second | 0.015 ms |
| Reading the weights: 15.23 GB ÷ 3,350 GB a second | 4.55 ms |

Reading memory takes about 300 times longer than the maths. The arithmetic units sit idle almost all the time, waiting for weights to arrive. So a single user gets at most 1 ÷ 4.55 ms ≈ 220 tokens a second, however fast the maths is.

Prefill is the opposite. It reads the weights once for the whole prompt: 1,500 tokens × 15.23 billion = 22.8 trillion operations, which takes 23 ms at best on an H100. Here the maths is the limit. That is why the first token (after prefill) arrives fast, and the rest arrive at a steady pace.

Two ideas follow, and the rest of this note builds on them:

- **Smaller weights mean faster answers**, not just less memory. Half the bytes means half the reading.
- **Batching is almost free.** If 16 users are each waiting for their next token, one read of the weights serves all 16. The engine does 16 times the maths, which it had time for anyway.

## How much memory: the weights

Weights in bytes = number of weights × bytes per weight. For the three Qwen2.5 sizes:

| Precision | Bytes a weight | Qwen2.5-7B | Qwen2.5-32B | Qwen2.5-72B |
|---|---|---|---|---|
| BF16 | 2 | 15.23 GB | 65.53 GB | 145.41 GB |
| FP8 (8-bit floating point) | 1 | 8.71 GB | 34.32 GB | 75.20 GB |
| 4-bit AWQ (a 4-bit method, below) | about 0.52 | 5.57 GB | 19.33 GB | 41.46 GB |

Why isn't 4-bit exactly a quarter of BF16? Two reasons:

- **Two layers stay at 16 bits.** The first layer (turning token ids into numbers) and the last (scoring every possible next token) each have 152,064 rows × 3,584 numbers for the 7B model. Together that is 1,089,994,752 weights, kept at 2 bytes: 2.18 GB. Quantized files usually leave them alone, because they are sensitive to rounding.
- **Each group of 128 weights stores a scale.** A 16-bit scale and a 4-bit zero point add 2.5 bytes for every 128 weights: about 0.02 bytes a weight. So a "4-bit" weight costs about 0.52 bytes.

Check for the 7B model: 6,525,621,760 weights × 0.52 bytes + 2.18 GB = 5.57 GB. The real Qwen2.5-7B-Instruct-AWQ files on Hugging Face are 5,570,829,760 bytes. The other sizes match within 0.4%.

### Which GPU fits?

A GPU's memory must hold the weights, the KV cache and the engine's working memory. You can't use all of it. In vLLM you choose the share with `--gpu-memory-utilization`; here we use 0.9 (90%). We also set aside 2 GB a GPU for working memory. That is an assumption: vLLM measures the real figure when it starts.

| GPU | Memory | Memory speed | Usable for weights and KV cache |
|---|---|---|---|
| L4 (Nvidia's small data-centre card) | 24 GB | 300 GB/s | 24 × 0.9 − 2 = 19.6 GB |
| RTX 4090 (Nvidia's top gaming card of 2022) | 24 GB | 1,008 GB/s | 19.6 GB |
| A100 80GB (Nvidia's data-centre card from 2020) | 80 GB | 2,039 GB/s | 80 × 0.9 − 2 = 70 GB |
| H100 (Nvidia's data-centre card from 2022) | 80 GB | 3,350 GB/s | 70 GB |

These use each card's listed memory. Real cards have a little more (an "80 GB" card holds about 85 billion bytes), so these results are slightly on the safe side.

If the weights don't fit on one GPU, you split every matrix across several GPUs. That is **tensor parallelism**: with 4 GPUs, each holds a quarter of every matrix, and they swap partial results after each layer. Qwen2.5-72B at BF16 (145.41 GB) needs 4 H100s: two give only 140 GB. The split must divide the number of attention heads evenly, so 1, 2, 4 or 8 GPUs, never 3.

## Quantization: fewer bits for each weight

**Quantization** stores each weight with fewer bits, like rounding prices to the nearest 10 rupees. You lose a little detail and save a lot of space.

One group of weights, rounded to 4 bits:

1. Find the group's range. Say the smallest weight is −0.12 and the largest is 0.18.
2. 4 bits give 16 levels (0 to 15), so each level is a step of (0.18 − (−0.12)) ÷ 15 = 0.02.
3. A weight of 0.071 becomes level round((0.071 + 0.12) ÷ 0.02) = round(9.55) = **10**. Only "10" is stored: 4 bits instead of 16.
4. When the model runs, 10 turns back into −0.12 + 10 × 0.02 = **0.08**. The error is 0.009.

The group's start (−0.12) and step (0.02) are stored once for the group. That is the scale and zero point from the table above.

Common methods:

- **FP8** (8-bit floating point): 1 byte a weight. Recent GPUs (L4, RTX 4090, H100) do FP8 maths directly, so it is fast and loses very little.
- **AWQ** (activation-aware weight quantization): 4-bit. It finds the small share of weights that matter most, by looking at which inputs are large, and protects them before rounding.
- **GPTQ** (a 4-bit method for GPT-style models): rounds the weights column by column and adjusts the rest to cancel the error.
- **GGUF** (the file format of llama.cpp, which runs models on laptops): holds weights at many bit sizes, with names such as `Q4_K_M` for a 4-bit mix.

What does 4-bit cost in quality? Usually a small drop on everyday tasks, and more on hard maths and code. The only answer that counts is your own test set: run the same questions on BF16 and 4-bit, and compare.

The KV cache can be quantized too: `--kv-cache-dtype fp8` stores it at 1 byte a number, which doubles the number of tokens that fit.

## The KV cache

To pick the next token, every layer compares it with **all earlier tokens**. This step is **attention**. For each earlier token it needs two short lists of numbers: a **key** (what this token is about) and a **value** (what it contributes). Working these out again for every token at every step would be very slow. So the engine keeps them in GPU memory. That store is the KV cache.

Its size per token:

```
bytes per token = 2 (key and value) × layers × KV heads × head size × 2 bytes
```

- **Layers**: 28 for Qwen2.5-7B.
- **KV heads**: 4. Attention runs in parallel "heads". Qwen2.5 uses **grouped-query attention** (several query heads share one key-value head), so the 7B model has 28 query heads but only 4 key-value heads. That shrinks the cache 7 times.
- **Head size**: 128 numbers (3,584 ÷ 28 heads).
- **2 bytes**: each number is BF16.

| Model | Calculation | Bytes a token | One 2,000-token chat | One 131,072-token request (the longest allowed) |
|---|---|---|---|---|
| Qwen2.5-7B | 2 × 28 × 4 × 128 × 2 | 57,344 | 115 MB | 7.52 GB |
| Qwen2.5-32B | 2 × 64 × 8 × 128 × 2 | 262,144 | 524 MB | 34.36 GB |
| Qwen2.5-72B | 2 × 80 × 8 × 128 × 2 | 327,680 | 655 MB | 42.95 GB |

One very long request on the 72B model needs more cache than the whole 4-bit model. This is why you set `--max-model-len` to what you need, not the maximum.

### Paged attention

Early engines reserved one long, unbroken piece of memory for each request, as long as it *might* grow. Most of that space was never used. vLLM's **paged attention** works like an operating system's memory pages instead. The cache is cut into small blocks (16 tokens each, for example). A request gets a new block only when it needs one, and blocks don't have to sit next to each other. Almost no memory is wasted, so many more requests fit.

## Serving it: batching and vLLM

**vLLM** is an open-source inference engine. You give it a model, and it serves an API that looks like OpenAI's. It does the hard parts for you: paged attention, batching, quantized weights and splitting across GPUs.

**Continuous batching**: the engine runs every waiting request together, one token per step for each. When one request finishes, a new one joins at the very next step. Older engines waited for a whole batch to finish, so short answers sat idle behind long ones.

This starts a server with the 4-bit 7B model on one GPU:

```bash
pip install vllm
vllm serve Qwen/Qwen2.5-7B-Instruct-AWQ \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.9
```

- `--max-model-len 8192`: no request (prompt plus answer) may pass 8,192 tokens. That limits how much cache one request can take.
- `--gpu-memory-utilization 0.9`: vLLM may use 90% of the GPU's memory. After loading the weights and measuring its working memory, it gives the rest to the KV cache, and logs how many tokens fit.
- It downloads the 5.57 GB of weights from Hugging Face the first time, then listens on port 8000.

Any OpenAI-style client can now call `http://localhost:8000/v1/chat/completions`. With `"stream": true`, the answer comes back as **server-sent events**: a stream of small chunks over one HTTP response, a few characters each.

For a bigger model, add `--tensor-parallel-size 4` to split it across 4 GPUs on one machine. Those GPUs swap data after every layer, so they need a fast link between them (Nvidia's NVLink); cards that only talk over the motherboard are much slower at this.

## Follow one example: 16 users on one L4

The topic's simulator does this arithmetic. Here is its opening example: Qwen2.5-7B-Instruct at BF16 on one L4, with 16 users each sending a chat of 1,500 tokens in and 500 out.

| Step | Calculation | Result |
|---|---|---|
| Weights | 7,615,616,512 × 2 bytes | 15.23 GB |
| Space for the KV cache | 24 GB × 0.9 − 2 GB − 15.23 GB | 4.37 GB |
| Cache a token | 2 × 28 × 4 × 128 × 2 | 57,344 bytes |
| Tokens that fit | 4,368,766,976 ÷ 57,344 | 76,185 tokens |
| Chats that fit at once | 76,185 ÷ 2,000 | 38: all 16 users run together |
| Cache read each step | 16 users × (1,500 + 250) tokens on average × 57,344 bytes | 1.61 GB |
| Time a step | (15.23 + 1.61) GB ÷ 300 GB/s | 56.1 ms |
| Speed for each user | 1 ÷ 56.1 ms | at most 17.8 tokens a second |
| A whole answer | 500 tokens × 56.1 ms | at least 28 s |

(On average a chat is halfway through its answer, so each has 1,500 + 250 tokens in its cache.)

17.8 tokens a second is faster than most people read, but 28 seconds for a full answer feels slow. Now change one thing at a time:

| Change | Chats that fit | Time a step | Speed for each user |
|---|---|---|---|
| None (BF16 on an L4) | 38 | 56.1 ms | 17.8 tokens/s |
| 4-bit AWQ instead | 122 | 23.9 ms | 41.8 tokens/s |
| RTX 4090 instead (same memory, faster) | 38 | 16.7 ms | 59.9 tokens/s |
| H100 instead | 477 | 5.0 ms | 199 tokens/s |
| 72B at BF16 on 4 H100s | 205 | 11.5 ms | 86.7 tokens/s |
| 72B at 4-bit on one H100 | 43 | 15.1 ms | 66.2 tokens/s |

- **4-bit on the same card** frees 9.66 GB for the cache (3.2 times the chats), and the weights each step reads are 2.7 times smaller.
- **The RTX 4090** has the same 24 GB but 3.4 times the memory speed, so it is 3.4 times faster for the same number of chats.
- **72B on one H100 at 4-bit** fits only 43 chats, while 4 H100s at BF16 fit 205 and answer faster. You pay for 4 cards, though.

These are upper limits. Real engines lose some time to scheduling, prefill and, across GPUs, to swapping data. Expect maybe 60 to 80% of them.

## How to choose: model, precision and GPU

1. **Start from quality.** Pick the smallest model that passes your own test set. Many tasks (sorting tickets, pulling fields from text, short answers) work well on 7B. Hard reasoning needs 32B or more.
2. **Then precision.** Try FP8, then 4-bit. Keep the smallest that still passes your tests.
3. **Then the GPU.** Weights + 2 GB working memory must fit in 90% of the card's memory, with room left for the cache. Faster memory means faster answers.
4. **Then size the cache.** Tokens per conversation × conversations at once × bytes a token. If it doesn't fit, cap `--max-model-len`, use an FP8 cache, or add replicas.
5. **Scale with replicas.** One copy of the model per GPU (or per group of GPUs) behind a load balancer. Split a model across GPUs only when it doesn't fit on one.

Should you run your own model at all?

| Use a hosted API when… | Run your own when… |
|---|---|
| traffic is low or spiky; a GPU would sit idle | traffic is steady enough to keep GPUs busy |
| you need the strongest closed models | an open model passes your tests |
| you have no one to run GPUs | data must not leave your network |
| you want to start today | you want to fine-tune, or need a fixed version that never changes |

On a laptop, **Ollama** or **llama.cpp** run GGUF files on a normal computer: `ollama run qwen2.5:7b` downloads a 4-bit build of about 5 GB and starts a chat.

## ⚠️ Critical Mistakes

- **Sizing for the weights only.** The weights fit, the server starts, and then only 2 or 3 users fit in the cache. Size the cache too.
- **Leaving the context length at the maximum.** One 131,072-token request on the 72B model needs 42.95 GB of cache. Set `--max-model-len` to what you need.
- **Quantizing without testing.** 4-bit can quietly hurt maths, code or a language you care about. Compare it with BF16 on your own test set.
- **Splitting a model across GPUs that have no fast link.** The GPUs swap data after every layer; over a slow link, 4 cards can be barely faster than 1.
- **Measuring speed with one user.** One user tells you the delay; real load tells you the throughput. Test with as many users at once as you expect.
- **Downloading weights on every start.** 15.23 GB at 125 MB a second is 2 minutes before the first answer. Keep weights on local disk or a fast cache, and keep warm replicas.
- **Ignoring the licence.** "Open weights" doesn't always mean "use it however you like".
- **Round-robin load balancing.** One replica can be full while another is idle. Route by queue length or free cache.

## Interview Q&As

**Q: How much GPU memory does a 70-billion-weight model need?**

A: At BF16 (2 bytes a weight), 70 billion × 2 = 140 GB for the weights alone, so two 80 GB cards aren't enough once you add working memory and the cache; it takes four. At 4 bits it is about 40 GB, which fits on one 80 GB card with room left for the KV cache. Then add the cache: for a model like Qwen2.5-72B, 327,680 bytes a token.

**Q: Why is generating tokens limited by memory bandwidth and not by compute?**

A: Each decode step makes one token per request, but it must read every weight from memory to do it. For a 7B model on an H100, reading 15.23 GB takes 4.55 ms while the maths takes about 0.015 ms. So the GPU waits on memory. Batching helps because one read of the weights serves every request in the batch.

**Q: What is the KV cache, and what makes it grow?**

A: For every token so far, each layer keeps a key and a value so attention doesn't recompute them. Its size is 2 × layers × KV heads × head size × bytes, for every token of every running request. It grows with context length and with the number of users. Grouped-query attention, an FP8 cache and a lower `--max-model-len` shrink it.

**Q: What does continuous batching improve over static batching?**

A: Static batching starts a batch together and waits for the longest answer to finish, so short requests sit idle and new ones wait. Continuous batching adds a request the moment another finishes, at the next step. The GPU stays full and short answers come back sooner.

**Q: How would you serve an open model to 500 users at once?**

A: Size one replica first: memory for weights and cache, and tokens a second. Then divide. If one H100 runs Qwen2.5-7B at BF16 for about 477 chats at once, that is two replicas with headroom, behind a load balancer that routes by queue length. Add autoscaling on queue time and cache use, warm replicas with weights on local disk, and a test set to check every new model version.

**Q: When would you split a model across GPUs?**

A: Only when it doesn't fit on one, like Qwen2.5-72B at BF16 (145.41 GB). Tensor parallelism splits every matrix and needs a fast link between the GPUs. For more users, add whole replicas instead: they don't need to talk to each other.

## Related topics

- [LLM Gateway](/?topic=llm-gateway&read): one front door for hosted and self-hosted models, with keys, budgets and fallbacks.
- [LLM Guardrails](/?topic=llm-guardrails&read): checking answers, generative reward models as judges, and test sets.
- [RAG Pipeline](/?topic=rag-pipeline&read): giving the model your own documents, which makes prompts (and the KV cache) longer.
- [Load Balancer](/?topic=load-balancer&read): spreading requests across replicas.

## Sources

- Qwen on Hugging Face: [Qwen2.5-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct) (and its [config.json](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/main/config.json)), [Qwen2.5-7B-Instruct-AWQ](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ), [Qwen2.5-32B-Instruct](https://huggingface.co/Qwen/Qwen2.5-32B-Instruct), [Qwen2.5-72B-Instruct](https://huggingface.co/Qwen/Qwen2.5-72B-Instruct)
- OrionLLM: [GRM-2.6-Plus](https://huggingface.co/OrionLLM/GRM-2.6-Plus)
- vLLM: [documentation](https://docs.vllm.ai/), [engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html) and [quantization](https://docs.vllm.ai/en/latest/features/quantization/)
- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180) (2023)
- Lin et al., [AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration](https://arxiv.org/abs/2306.00978) (2023)
- Nvidia: [H100](https://www.nvidia.com/en-us/data-center/h100/), [A100](https://www.nvidia.com/en-us/data-center/a100/) and [L4](https://www.nvidia.com/en-us/data-center/l4/) specifications

## Why This Matters

"Should we host our own model?" is now a common design question, and the answer is arithmetic. If you can say "7.6 billion weights at 2 bytes is 15.23 GB; on a 24 GB card that leaves 4.37 GB of cache, 38 chats at once, and at 300 GB/s about 18 tokens a second each; at 4-bit it's 122 chats at 42 tokens a second", you can turn a vague question into a GPU count and a bill. The same three ideas (weights' size, the KV cache, and memory speed) explain why quantization, batching and paged attention exist.
