import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'What is near me?',
      text: 'Apps like Google Maps find places near you in milliseconds, out of 200 million places. Scanning every row for each search is far too slow.',
      focus: ['Client (Mobile App)', 'Location Search Service'],
    },
    {
      title: 'The numbers',
      text: '100 million users search 5 times a day: 500 million searches, about 5,800 a second. Only about 12 places change a second. Reads win about 500 to 1.',
      example: '500 million ÷ 86,400 s ≈ 5,800 a second',
    },
    {
      title: 'Cut the map into cells',
      text: 'A geohash turns a point into a short string, like "tdr1w". Each letter makes the cell smaller. Places whose geohashes share a beginning are close together.',
      focus: ['Geohash Index (Redis)'],
      remember: 'Nearby becomes a key lookup.',
    },
    {
      title: 'A list of places per cell',
      text: 'The Geohash Index in Redis keeps, for each cell, the ids of the places inside it. A search reads a few small lists instead of every row.',
      focus: ['Location Search Service', 'Geohash Index (Redis)'],
      example: 'geo:tdr1w → [b-101, b-207, b-388]',
    },
    {
      title: 'Search 9 cells, not 1',
      text: 'Two shops a metre apart can sit in different cells, on either side of a border. So search your cell and its 8 neighbours, or places across the border go missing.',
      focus: ['Location Search Service'],
    },
    {
      title: 'Filter by true distance',
      text: 'Cells are rectangles, not circles. So the service measures the real distance to each candidate and keeps only those inside the radius.',
    },
    {
      title: 'Details come from the Business Service',
      text: 'With the ids found, the Business Service fills in names, ratings and photos, from its cache first, then the database.',
      focus: ['Business Service', 'Business Cache (Redis)', 'Business DB (primary + replicas)'],
    },
    {
      title: 'Updates can wait a few seconds',
      text: 'When an owner edits a place, the change goes on a queue. The Index Builder updates the geohash lists shortly after. Searchers don\'t notice a few seconds\' delay.',
      focus: ['Business Owner', 'Update Queue', 'Index Builder'],
    },
  ],
  quiz: [
    {
      question: 'Why search the 8 neighbouring cells too?',
      options: ['To find more ads', 'A place just across a cell border would be missed', 'Redis needs it', 'To sort results'],
      answer: 1,
      why: 'Two close points can have different geohashes if a border runs between them.',
    },
    {
      question: 'What does sharing a geohash prefix tell you?',
      options: ['The places are close together', 'They have the same owner', 'They opened the same day', 'Nothing'],
      answer: 0,
      why: 'A longer shared prefix means a smaller shared cell, so the places are near each other.',
    },
    {
      question: 'Why may the index update a few seconds after an edit?',
      options: ['Search is read-heavy and tolerates small delays on writes', 'Redis is slow', 'Owners prefer it', 'Geohashes change daily'],
      answer: 0,
      why: 'Reads outnumber writes about 500 to 1, so updating the index asynchronously is fine.',
    },
  ],
}

export default lesson
