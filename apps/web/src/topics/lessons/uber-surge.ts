import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Why prices rise',
      text: 'Surge pricing raises the fare where riders outnumber free drivers. The higher price pulls more drivers to that area.',
      focus: ['Rider App', 'Driver App', 'Pricing Service'],
    },
    {
      title: 'Counted per hexagon',
      text: 'The city is cut into H3 hexagons. Driver locations stream through Kafka, and the Stream Processor counts riders asking and free drivers in each hexagon.',
      focus: ['Kafka (location events)', 'Stream Processor', 'Supply & Demand per H3 Cell'],
    },
    {
      title: 'The rule',
      text: 'In this topic, the multiplier is 1 + (riders ÷ drivers − 1) × 0.4, between 1× and 3×. With 30 riders and 10 drivers, the ratio is 3, so the price is 1.8×.',
      example: '1 + (3 − 1) × 0.4 = 1.8×\n₹250 × 1.8 = ₹450',
    },
    {
      title: 'Faking a shortage',
      text: 'If the price reacts to live supply, drivers can game it. 5 drivers log out together, the ratio jumps to 6, and the price hits 3×. This is artificial scarcity.',
      example: '1 + (6 − 1) × 0.4 = 3.0× → ₹750',
      remember: 'A price driven by a snapshot can be gamed.',
    },
    {
      title: 'Spot the group logout',
      text: 'Many drivers going offline in one place at once is a warning sign. The Coordinated Drop-off check flags it, and those drivers don\'t lower the supply count.',
      focus: ['Coordinated Drop-off?'],
    },
    {
      title: 'Smooth over time and space',
      text: 'Supply is averaged over several minutes and neighbouring hexagons, never one snapshot. A fake shortage for a few minutes barely moves the price.',
      focus: ['Smooth over Time & Space', 'Demand Forecast'],
    },
    {
      title: 'Lock the rider\'s price',
      text: 'When a rider asks, the Pricing Service gives a quote locked for a short time. The price can\'t jump while they decide.',
      focus: ['Pricing Service', 'Locked Upfront Quote'],
    },
    {
      title: 'Bring drivers before the spike',
      text: 'The Demand Forecast predicts busy areas, and the Driver Heatmap shows drivers where to go. Dispatch matches riders and drivers.',
      focus: ['Driver Heatmap', 'Dispatch / Matching'],
    },
  ],
  quiz: [
    {
      question: 'How can drivers fake a shortage?',
      options: ['By driving faster', 'By logging out together in one area', 'By accepting every ride', 'By changing cars'],
      answer: 1,
      why: 'Fewer free drivers raises the riders-to-drivers ratio, and with it the price.',
    },
    {
      question: '30 riders and 10 drivers. What is the multiplier in this topic\'s rule?',
      options: ['3.0×', '1.8×', '1.2×', '2.4×'],
      answer: 1,
      why: 'Ratio 3: 1 + (3 − 1) × 0.4 = 1.8×.',
    },
    {
      question: 'Why smooth supply over minutes and nearby hexagons?',
      options: ['To make prices change faster', 'So a short, local fake shortage barely moves the price', 'To save memory', 'To hide drivers'],
      answer: 1,
      why: 'Averaging over time and space makes the price hard to manipulate.',
    },
  ],
}

export default lesson
