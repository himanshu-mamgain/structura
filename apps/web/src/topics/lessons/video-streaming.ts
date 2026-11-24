import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Two paths: upload and watch',
      text: 'A video site has a slow upload path that prepares videos, and a fast playback path that sends them to viewers. Storage is cheap; sending the bytes is the big cost.',
      focus: ['Client App', 'Upload Service', 'Playback Service'],
    },
    {
      title: 'Uploads go straight to storage',
      text: 'The Upload Service gives the app a pre-signed URL. The app uploads the big file in chunks directly to the Raw Video Store, so app servers never carry the bytes.',
      focus: ['Upload Service', 'Raw Video Store'],
    },
    {
      title: 'The scale of uploads',
      text: 'One hour of 8 Mbps video is 3.6 GB. At 500 hours uploaded a minute, that is 1.8 TB a minute, about 30 GB of new video every second.',
      example: '8 Mbps × 3,600 s ÷ 8 = 3.6 GB\n500 × 3.6 GB = 1.8 TB a minute',
    },
    {
      title: 'Transcode into many sizes',
      text: 'Transcoding Workers turn one upload into several renditions, from 144p to 1080p. Each rendition is cut into short segments of 2 to 6 seconds, which workers encode in parallel.',
      focus: ['Task Queue', 'Transcoding Workers', 'Processed Video Store'],
    },
    {
      title: 'Ready only when all sizes exist',
      text: 'The Metadata DB stores a status: processing or ready. A video is only offered once every rendition exists.',
      focus: ['Metadata DB'],
    },
    {
      title: 'The player picks the size',
      text: 'With adaptive bitrate streaming, the player measures its own bandwidth and picks a rendition every few seconds. On a slow train, it drops to 360p instead of stopping.',
      focus: ['Client App', 'Playback Service', 'Metadata Cache'],
    },
    {
      title: 'Segments come from the CDN',
      text: 'Segments never change, so the CDN Edge near the viewer can cache them for a year. Most bytes never reach your servers.',
      focus: ['CDN Edge'],
      remember: 'Immutable segments + a CDN = cheap, fast playback.',
    },
    {
      title: 'Popular first, long tail later',
      text: 'Popular videos get every rendition at once. Rarely watched ones can get fewer sizes or be encoded later, which saves a lot of computing.',
    },
  ],
  quiz: [
    {
      question: 'Why upload with a pre-signed URL?',
      options: ['It makes videos smaller', 'The file goes straight to object storage, not through app servers', 'It encodes the video', 'It adds subtitles'],
      answer: 1,
      why: 'App servers stay free; storage handles the huge, resumable upload.',
    },
    {
      question: 'A viewer\'s network slows down mid-video. What happens?',
      options: ['The video stops', 'The player switches to a lower rendition for the next segments', 'The server re-encodes the video', 'The CDN deletes the video'],
      answer: 1,
      why: 'Adaptive bitrate streaming picks the size every few seconds from measured bandwidth.',
    },
    {
      question: 'Why can a CDN cache segments for a year?',
      options: ['Segments never change once made', 'Viewers ask it to', 'Segments are tiny', 'CDNs ignore expiry'],
      answer: 0,
      why: 'Immutable files never go stale, so long caching is safe.',
    },
  ],
}

export default lesson
