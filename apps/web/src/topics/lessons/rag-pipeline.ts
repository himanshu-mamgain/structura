import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'The model doesn\'t know your documents',
      text: 'A language model only knows what it was trained on. RAG, retrieval-augmented generation, finds the right passages in your own documents and puts them in the prompt. The model answers from them, with citations.',
      focus: ['Employee', 'RAG API', 'LLM'],
    },
    {
      title: 'Cut documents into chunks',
      text: 'The Chunker splits documents into small pieces, about 80 words each, with a 10-word overlap so sentences stay whole. 50k pages of policies give about 357k chunks.',
      focus: ['Policy Docs', 'Chunker'],
      example: '25 million words ÷ 70 new words a chunk ≈ 357k chunks',
    },
    {
      title: 'Turn chunks into vectors',
      text: 'The Embedding Model turns each chunk into a vector: a list of 768 numbers that captures its meaning. Chunks with similar meaning get similar vectors.',
      focus: ['Embedding Model', 'Vector Index'],
      example: '768 × 4 bytes = 3,072 bytes a vector\n357k vectors ≈ 1.1 GB',
    },
    {
      title: 'Keep a keyword index too',
      text: 'Vectors match meaning but blur exact codes and names. A Keyword Index finds exact words like "LTA-2024". Searching both, called hybrid search, gets the best of each.',
      focus: ['Keyword Index', 'Vector Index', 'Retriever'],
    },
    {
      title: 'Retrieve many, keep the best',
      text: 'The Retriever takes about 50 candidates. The Reranker reads the question and each chunk together and judges relevance better. Only the best 4 go into the prompt.',
      focus: ['Retriever', 'Reranker'],
      remember: 'Retrieve 50, rerank, keep 4.',
    },
    {
      title: 'Build the prompt',
      text: 'The Prompt Builder puts the 4 chunks, the question and the rules together: "answer only from these passages, and cite them". That is about 716 tokens in.',
      focus: ['Prompt Builder', 'LLM'],
      example: '4 × 104 + 300 ≈ 716 tokens',
    },
    {
      title: 'Keep the index fresh',
      text: 'When a document changes, the Change Queue sends it to be chunked and embedded again. Old answers would otherwise quote old policies.',
      focus: ['Policy Docs', 'Change Queue'],
    },
    {
      title: 'Most wrong answers are bad retrieval',
      text: 'If the right chunk never reaches the prompt, the model can\'t answer well. So measure retrieval on its own (was the right chunk in the top 4?) and the answer on its own.',
    },
  ],
  quiz: [
    {
      question: 'An employee searches for policy code "LTA-2024" and gets nothing useful. What helps most?',
      options: ['A bigger model', 'Adding keyword search alongside vectors (hybrid)', 'Longer chunks', 'More overlap'],
      answer: 1,
      why: 'Embeddings blur exact codes; a keyword index matches them exactly.',
    },
    {
      question: 'Why rerank instead of putting all 50 candidates in the prompt?',
      options: ['To save tokens and keep only the most relevant chunks', 'Rerankers are free', 'The model can read only one chunk', 'To make chunks shorter'],
      answer: 0,
      why: 'A reranker judges relevance well; 4 good chunks beat 50 mixed ones.',
    },
    {
      question: 'The answer is wrong but sounds sure. Where should you look first?',
      options: ['The font', 'Whether the right chunk was retrieved', 'The API gateway', 'The employee'],
      answer: 1,
      why: 'Most RAG errors come from retrieval missing the right passage.',
    },
  ],
}

export default lesson
