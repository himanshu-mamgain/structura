import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'When a whole region goes',
      text: 'Running in two Availability Zones survives losing one data centre. Disaster recovery (DR) is about bigger losses: a whole region, or your data deleted or broken.',
      focus: ['Customers', 'Route 53', 'Mumbai Load Balancer'],
    },
    {
      title: 'Two numbers: RTO and RPO',
      text: 'RTO (recovery time objective) is how long you may be down. RPO (recovery point objective) is how much recent data you may lose, measured in time. These two numbers decide everything else.',
      example: '1,500 orders an hour = 25 a minute\nRPO of 16 hours  → 24k orders lost\nRPO of 10 minutes → 250\nRPO of 5 seconds  → about 2',
    },
    {
      title: 'Backup and restore',
      text: 'The cheapest way: keep snapshots and copy them to a second region, here Hyderabad. After a disaster, rebuild everything there with Terraform and restore the database. It takes hours.',
      focus: ['Snapshots in Mumbai', 'Snapshot Copies in Hyderabad', 'Terraform', 'Hyderabad Database'],
      example: '30 min to decide + 45 min Terraform + 60 min to restore 500 GB\n+ 15 min of tests + 5 min for DNS = 155 minutes',
    },
    {
      title: 'Pilot light',
      text: 'Keep only the database running in the second region, copied from the main one all the time. The servers are off. In a disaster, promote that database and start the servers.',
      focus: ['Mumbai Database', 'Hyderabad Database'],
      example: '15 min to decide + 10 min to promote and boot + 5 min for DNS = 30 minutes',
    },
    {
      title: 'Warm standby',
      text: 'A smaller copy of the whole system runs all the time in the second region. Failover is mostly automatic and takes about 10 minutes.',
      focus: ['Hyderabad Load Balancer', 'Hyderabad App Servers', 'Hyderabad Database'],
    },
    {
      title: 'Active/active',
      text: 'Both regions serve customers all the time. If one fails, health checks move everyone to the other in about 2 minutes, losing about a second of data. It costs the most and is the hardest to build.',
      focus: ['Route 53', 'Mumbai Load Balancer', 'Hyderabad Load Balancer'],
      example: 'Extra cost each month, next to a $2k production stack (illustrative)\nbackup and restore $0 · pilot light $400\nwarm standby $850 · active/active $2,100',
    },
    {
      title: 'Route 53 moves the traffic',
      text: 'Route 53 health checks watch the main region. A failover record answers with Mumbai while it\'s healthy, and with Hyderabad when it isn\'t.',
      focus: ['Customers', 'Route 53', 'Hyderabad Load Balancer'],
    },
    {
      title: 'A replica is not a backup',
      text: 'Replication copies everything, mistakes included. If someone drops a table, the replica drops it too, a second later. Only point-in-time backups can bring it back.',
      focus: ['Mumbai Database', 'Hyderabad Database', 'Snapshots in Mumbai'],
      remember: 'Practise the failover. A plan nobody has tried usually fails.',
    },
  ],
  quiz: [
    {
      question: 'What does RPO measure?',
      options: ['How long the site may be down', 'How much recent data you may lose', 'How many regions you use', 'How fast DNS changes'],
      answer: 1,
      why: 'RPO is the window of data you could lose. RTO is the time you may be down.',
    },
    {
      question: 'Which strategy is cheapest, but takes hours to recover?',
      options: ['Active/active', 'Warm standby', 'Pilot light', 'Backup and restore'],
      answer: 3,
      why: 'Nothing runs in the second region, so everything has to be rebuilt and restored first.',
    },
    {
      question: 'Someone drops the orders table. What brings it back?',
      options: ['The replica in the other region', 'A point-in-time backup', 'Route 53 failover', 'Restarting the app servers'],
      answer: 1,
      why: 'The replica copied the drop too. A backup from before the mistake still has the table.',
    },
  ],
}

export default lesson
