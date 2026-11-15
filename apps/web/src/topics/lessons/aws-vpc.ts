import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Your own private network in AWS',
      text: 'A VPC (virtual private cloud) is a private network inside one AWS region. Everything you run that has a network address lives in it: servers, containers, databases and load balancers. Nothing gets in unless you open a door.',
    },
    {
      title: 'Pick an address range',
      text: 'You give the VPC a range of addresses, written in CIDR notation. 10.0.0.0/16 means the first 16 bits are fixed, which leaves 2^16 addresses. Choose a big range that doesn\'t overlap your other networks: the main range can\'t be changed later.',
      example: '10.0.0.0/16 → 65,536 addresses\nsplit into /24 subnets → 256 subnets of 256 addresses',
      remember: 'AWS keeps 5 addresses in every subnet, so a /24 gives you 251.',
    },
    {
      title: 'Subnets: one zone each, three kinds',
      text: 'A subnet is a slice of the VPC\'s range in one Availability Zone. The usual plan has three kinds in every zone: public subnets for the load balancer, private subnets for your app, and database subnets with no route to the internet at all.',
      focus: ['Load Balancer', 'App Tasks (zone a)', 'Database (primary)'],
    },
    {
      title: 'Route tables decide where traffic goes',
      text: 'Each subnet has a route table: a list of "traffic for these addresses goes there". Every table has a local route, so everything inside the VPC can reach everything else. When several routes match, AWS uses the most specific one.',
      focus: ['Public Route Table', 'Private Route Table'],
      example: 'Private route table\n10.0.0.0/16 → local\n0.0.0.0/0   → NAT gateway',
      remember: '0.0.0.0/0 means "every other address".',
    },
    {
      title: 'The internet gateway is the front door',
      text: 'A subnet is public when its route table sends 0.0.0.0/0 to the internet gateway. Visitors come in through it to the load balancer, which passes their requests to the app in the private subnets.',
      focus: ['Visitor', 'Internet', 'Internet Gateway', 'Load Balancer'],
    },
    {
      title: 'NAT: calling out without being called in',
      text: 'Sometimes your app calls an outside API, like a payment provider. A NAT gateway in a public subnet lets private subnets open connections out, but nothing on the internet can open a connection in. Use one per zone, so each zone keeps working on its own.',
      focus: ['App Tasks (zone a)', 'Private Route Table', 'NAT Gateway (zone a)', 'External API'],
      example: '$0.045 an hour × 730 hours ≈ $32.85 a month per NAT gateway\nplus $0.045 for every GB it handles',
    },
    {
      title: 'A free road to S3',
      text: 'Traffic to S3 through a NAT gateway costs money for every gigabyte. An S3 gateway endpoint adds a route that takes S3 traffic straight there, over AWS\'s own network, for free.',
      focus: ['Private Route Table', 'S3 Gateway Endpoint', 'S3'],
      example: '30 TB a month to S3\nthrough NAT: 30,000 GB × $0.045 = $1,350\nthrough the endpoint: $0',
    },
    {
      title: 'Databases sit deepest',
      text: 'Database subnets have only the local route, so there is no way to or from the internet. Only the app can reach the database. A standby copy in another zone takes over if the primary\'s zone fails.',
      focus: ['App Tasks (zone a)', 'Database (primary)', 'Database (standby)'],
      remember: 'Security groups add a second lock: the database accepts port 5432 only from the app.',
    },
  ],
  quiz: [
    {
      question: 'What makes a subnet public?',
      options: ['It has more than 256 addresses', 'Its route table sends 0.0.0.0/0 to the internet gateway', 'It holds the database', 'It is in zone a'],
      answer: 1,
      why: 'Public or private is only about the route. With a route to the internet gateway, things in it can be reached from the internet.',
    },
    {
      question: 'Your app in a private subnet must call a payment provider. What does it use?',
      options: ['The S3 gateway endpoint', 'A database subnet', 'A NAT gateway in a public subnet', 'Nothing: private subnets can never reach the internet'],
      answer: 2,
      why: 'NAT lets private subnets call out, while still keeping the internet from calling in.',
    },
    {
      question: 'How do you stop paying NAT charges for traffic to S3?',
      options: ['Add an S3 gateway endpoint', 'Use a bigger NAT gateway', 'Put S3 in a public subnet', 'Remove the route table'],
      answer: 0,
      why: 'The endpoint is a free route to S3 that never goes through NAT or the internet.',
    },
  ],
}

export default lesson
