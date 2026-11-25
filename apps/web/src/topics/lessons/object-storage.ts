import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Where do big files live?',
      text: 'Photos, videos and backups need a place that never fills up and almost never loses a file. That place is an object store. Amazon S3 is the best known one.',
      focus: ['Client', 'API Gateway'],
    },
    {
      title: 'Buckets, objects and keys',
      text: 'A bucket is a named container. An object is one file. Its key is its name, like photos/2026/cat.jpg. The slashes are just letters, not real folders.',
      example: 'PUT photos/2026/cat.jpg',
    },
    {
      title: 'Write once, read whole',
      text: 'You write a file whole and read it whole. You never change a few bytes in the middle. To change it, you upload a new version. This keeps everything simple.',
      remember: 'Stored bytes never change.',
    },
    {
      title: 'Two parts: index and bytes',
      text: 'A small, fast Metadata DB says where each key is. A huge pool of storage nodes holds the bytes. Each part grows on its own.',
      focus: ['Metadata Service', 'Metadata DB', 'Storage Nodes (Zone A)'],
    },
    {
      title: 'Why not three copies?',
      text: 'Three full copies survive 2 lost disks, but cost 3 times the space. For 50 PB of data, that is 150 PB of disk, or 7,500 disks of 20 TB.',
      example: '50 PB × 3 = 150 PB',
    },
    {
      title: 'Erasure coding',
      text: 'Cut the file into 6 data shards and add 3 parity shards, which are computed from the data. Any 6 of the 9 shards rebuild the file. It survives 3 lost shards for only 1.5 times the space.',
      focus: ['Erasure Coder'],
      example: '9 ÷ 6 = 1.5×',
      remember: 'Less space, more safety.',
    },
    {
      title: 'Spread over zones',
      text: 'Put the shards in three zones, which are separate buildings. With 6+3, each zone holds 3 shards, so a whole building can burn and the file is still there.',
      focus: ['Storage Nodes (Zone A)', 'Storage Nodes (Zone B)', 'Storage Nodes (Zone C)'],
    },
    {
      title: 'Write the index last',
      text: 'The Metadata Service records the key only after every shard is safely stored. So a reader never sees a key that points to nothing.',
      focus: ['Metadata Service', 'Metadata DB'],
    },
    {
      title: 'Checks and repairs',
      text: 'Every shard has a checksum, a fingerprint of its bytes. The Scrubber reads shards in the background and compares. A bad or lost shard is rebuilt by the Repair Service from the rest.',
      focus: ['Scrubber (checksums)', 'Repair Service'],
      remember: 'Fast repair is what makes loss so rare.',
    },
  ],
  quiz: [
    {
      question: 'Why is the metadata row written last?',
      options: ['It is the smallest', 'A reader should never find a key whose shards are not stored yet', 'Disks need it', 'To save money'],
      answer: 1,
      why: 'The row is the commit point. Before it exists, the object does not exist for readers.',
    },
    {
      question: 'Erasure coding 6+3 stores how much compared with the file size?',
      options: ['3 times', '2 times', '1.5 times', 'The same'],
      answer: 2,
      why: '9 shards, each one sixth of the file: 9 ÷ 6 = 1.5 times, and it survives 3 lost shards.',
    },
    {
      question: 'What finds a disk that returns wrong bytes without an error?',
      options: ['The load balancer', 'Checksums, checked on read and by the scrubber', 'The client', 'The zone'],
      answer: 1,
      why: 'Each shard has a checksum saved when it was written. A different checksum means the bytes changed.',
    },
  ],
}

export default lesson
