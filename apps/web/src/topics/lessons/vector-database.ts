import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Find what is nearest in meaning',
      text: 'An embedding model turns a photo or sentence into a vector: a list of numbers that captures its meaning. A vector database finds the stored vectors nearest to a query.',
      focus: ['Search App', 'Embedding Model', 'Vector DB API'],
    },
    {
      title: 'Comparing with everything is slow',
      text: 'One 768-number vector is 3,072 bytes. A flat scan of 1 million reads 3.07 GB per query: about 77 ms at 40 GB/s. That\'s only about 13 queries a second per server.',
      example: '1 million × 3,072 bytes = 3.07 GB a query',
    },
    {
      title: 'Approximate is fast enough',
      text: 'An approximate index skips most vectors and still finds almost all the true nearest ones. You trade a little recall, the share of true matches found, for a huge speed-up.',
      remember: 'Measure recall against an exact scan.',
    },
    {
      title: 'HNSW: a graph of neighbours',
      text: 'HNSW links each vector to its close neighbours. A search walks from neighbour to neighbour towards the query. It is fast and accurate, but keeps full vectors and links in memory.',
      focus: ['HNSW Graph'],
    },
    {
      title: 'IVF-PQ: small and clustered',
      text: 'IVF groups vectors into clusters and searches only the nearest few. PQ compresses each vector to a 96-byte code. 100 million vectors fit in about 10.4 GB on one server.',
      focus: ['IVF-PQ Index', 'Raw Vectors'],
      example: '100 million × 104 bytes = 10.4 GB',
    },
    {
      title: 'Shards, then merge',
      text: 'The Shard Router sends the query to every shard. Each returns its best matches, and Top-k Merge keeps the overall best.',
      focus: ['Shard Router', 'Top-k Merge'],
    },
    {
      title: 'Careful with filters',
      text: 'If you filter after an approximate search ("only in Pune"), a strict filter can leave almost nothing. When the filter is selective, use the metadata index first, then score those few directly.',
      focus: ['Filter Selective?', 'Metadata Index'],
    },
    {
      title: 'Writes are logged first',
      text: 'New vectors go to the Write-Ahead Log, so nothing is lost. The Index Builder adds them to the index in the background.',
      focus: ['Write-Ahead Log', 'Index Builder'],
    },
  ],
  quiz: [
    {
      question: 'Why not compare the query with every vector?',
      options: ['It is wrong', 'It reads gigabytes per query, which is too slow at scale', 'It needs a GPU', 'It breaks filters'],
      answer: 1,
      why: '1 million vectors is 3.07 GB per query; approximate indexes avoid most of that.',
    },
    {
      question: 'You search for shoes "only in Pune", and Pune has 0.1% of listings. What goes wrong with filtering afterwards?',
      options: ['Nothing', 'The approximate top results are mostly elsewhere, so almost none are left', 'Pune is not a city', 'The index crashes'],
      answer: 1,
      why: 'A selective filter after the search throws away nearly all candidates. Filter first or during the search.',
    },
    {
      question: 'What does IVF-PQ trade for its small size?',
      options: ['Some accuracy, recovered by re-ranking with full vectors', 'All accuracy', 'Write speed only', 'Nothing'],
      answer: 0,
      why: 'Compressed codes are approximate; re-ranking the top candidates with full vectors restores accuracy.',
    },
  ],
}

export default lesson
