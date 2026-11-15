import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Buying servers for the busiest hour',
      text: 'Picture a food-delivery app. At night it gets 60 requests a second; at dinner, 1,200. Before the cloud, you bought enough servers for dinner, and for most of the day they sat idle.',
      focus: ['Customers', 'Internet', 'Own Servers'],
      example: '8 servers × $1,800 = $14,400 up front\nthen about $560 a month to run them',
      remember: 'Over a whole day, those 8 servers do only about a quarter of the work they could.',
    },
    {
      title: 'Renting instead: AWS',
      text: 'AWS (Amazon Web Services) rents out servers, storage and databases. You start what you need in minutes and pay by the hour, or by the request. A rented virtual server is called an EC2 instance.',
      focus: ['EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
      example: '8 rented servers × $0.101 an hour × 720 hours ≈ $582 a month',
      remember: 'Nothing to pay up front, and when you stop a server, you stop paying for it.',
    },
    {
      title: 'Regions and Availability Zones',
      text: 'AWS has regions around the world, such as Mumbai (ap-south-1). Each region has several Availability Zones: separate data centres with their own power and network, far enough apart that a fire or flood in one doesn\'t reach the others.',
      focus: ['EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
      remember: 'Run in two zones, and losing one zone doesn\'t take your app down.',
    },
    {
      title: 'A load balancer shares the work',
      text: 'Customers reach one address: the load balancer. It spreads their requests over the servers in both zones and checks each server\'s health. A server that stops answering gets no more requests.',
      focus: ['Internet', 'Load Balancer', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
    },
    {
      title: 'Auto Scaling follows the traffic',
      text: 'CloudWatch is AWS\'s monitoring: it collects numbers such as CPU use. When the servers\' average CPU passes 70%, an alarm tells Auto Scaling to start more. When traffic drops, it stops some.',
      focus: ['CloudWatch', 'Auto Scaling', 'EC2 Servers in Zone A', 'EC2 Servers in Zone B'],
      example: '2 servers at night, up to 9 at dinner\n≈ 2,670 server-hours ≈ $270 a month',
      remember: 'You pay for the servers each hour needs, not for the peak all day.',
    },
    {
      title: 'Lambda: no servers to look after',
      text: 'With Lambda, you upload a function and AWS runs a copy for each request. You pay per request and per millisecond it runs, and nothing when nobody calls it.',
      focus: ['Internet', 'Lambda Functions'],
      example: '≈ 1.03 billion requests a month at 100 ms each\n≈ $1,062 a month',
      remember: 'Great for quiet or spiky traffic. For busy, steady traffic, servers can be cheaper.',
    },
    {
      title: 'A managed database: RDS',
      text: 'RDS runs a database such as Postgres for you: backups, updates and failover. The primary copies every write to a standby in the other zone straight away. If the primary\'s zone fails, the standby takes over in a minute or two.',
      focus: ['RDS Primary', 'RDS Standby'],
    },
    {
      title: 'S3 for files',
      text: 'S3 stores files of any size, like menu photos, as objects in a bucket. It keeps copies in several zones for you. You pay for the gigabytes you store and the requests you make.',
      focus: ['EC2 Servers in Zone A', 'S3 Bucket'],
    },
    {
      title: 'Watch the bill',
      text: 'Renting is flexible, but some costs surprise people: data sent out to the internet, NAT gateways, and servers someone forgot to stop. Set a budget alert on the first day.',
      remember: 'The cloud swaps a big up-front cost for a monthly bill that you design for and watch.',
    },
  ],
  quiz: [
    {
      question: 'Why does a food-delivery app waste money on servers it bought?',
      options: ['Bought servers can\'t run a database', 'It has to pay per request', 'It must buy enough for dinner, and they sit idle most of the day', 'Bought servers are slower'],
      answer: 2,
      why: 'You buy for the peak. At 60 requests a second at night, most of that capacity does nothing.',
    },
    {
      question: 'What is an Availability Zone?',
      options: ['A separate data centre in a region, with its own power and network', 'A country AWS is allowed to work in', 'A group of servers behind one load balancer', 'A price plan for EC2'],
      answer: 0,
      why: 'A region has several zones. Spreading servers and databases across two of them survives one zone failing.',
    },
    {
      question: 'At dinner, average CPU passes 70%. What starts more servers?',
      options: ['The load balancer', 'RDS', 'S3', 'Auto Scaling, when CloudWatch\'s alarm goes off'],
      answer: 3,
      why: 'CloudWatch measures the CPU and raises the alarm. Auto Scaling starts servers, and the load balancer then sends them requests.',
    },
  ],
}

export default lesson
