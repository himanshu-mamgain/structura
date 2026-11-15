import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'A whole app, end to end',
      text: 'This topic puts the pieces together: a Vue.js client and a Node.js API, each running as an ECS service behind its own load balancer, with DynamoDB for data and S3 for images. All of it is described in Terraform.',
      focus: ['Visitor', 'Client ALB', 'Client Tasks', 'Server ALB'],
    },
    {
      title: 'A request: client, API, data',
      text: 'A visitor loads pages from the client tasks. The page calls the API through the server load balancer, and the API reads and writes items in DynamoDB. Product images come straight from S3.',
      focus: ['Client Tasks', 'Server ALB', 'Blue Tasks (server)', 'DynamoDB Table', 'S3 Assets'],
    },
    {
      title: 'Every push starts the pipeline',
      text: 'When a developer pushes to GitHub, CodePipeline starts. CodeBuild builds the Docker image, pushes it to ECR, and prepares the files that describe the deploy.',
      focus: ['Developer', 'GitHub Repository', 'CodePipeline', 'CodeBuild', 'ECR'],
    },
    {
      title: 'Blue/green: two versions side by side',
      text: 'CodeDeploy starts the new version, called green, next to the running one, called blue. Green must pass its health checks before it gets any real traffic.',
      focus: ['CodeDeploy', 'Blue Tasks (server)', 'Green Tasks (server)'],
      remember: 'For a while you run twice the tasks, so leave room in your subnets and service limits.',
    },
    {
      title: 'Shifting traffic',
      text: 'CodeDeploy moves the load balancer\'s traffic from blue to green. All at once is fastest. A canary sends 10% first and waits. Linear moves a little more every few minutes.',
      focus: ['CodeDeploy', 'Server ALB', 'Green Tasks (server)'],
    },
    {
      title: 'An alarm that rolls back',
      text: 'A CloudWatch alarm counts green\'s 5xx errors, the server-side failures. If it goes off during the deploy, CodeDeploy points the traffic back at blue in seconds, because blue is still running.',
      focus: ['Green Tasks (server)', '5xx Alarm', 'CodeDeploy', 'Blue Tasks (server)'],
    },
    {
      title: 'What a canary saves',
      text: 'Imagine a release that breaks 30% of requests. The difference between all at once and a canary with an alarm is huge.',
      focus: ['5xx Alarm', 'CodeDeploy'],
      example: '3,000 requests a minute; 30% fail = 900 a minute\nAll at once, noticed after 15 min, fixed by minute 25:\n  26 × 900 = 23,400 failures\nCanary 10% + alarm after 2 min:\n  2 × 90 = 180 failures',
    },
    {
      title: 'Blue goes, and you hear about it',
      text: 'After a 5-minute wait with no alarm, blue is stopped. CodeDeploy sends the result to SNS, which emails the team.',
      focus: ['CodeDeploy', 'SNS Notifications', 'Blue Tasks (server)'],
    },
  ],
  quiz: [
    {
      question: 'During a blue/green deploy, where does traffic go before green passes its health checks?',
      options: ['To green only', 'To blue only', 'Half to each', 'Nowhere'],
      answer: 1,
      why: 'Green gets no real traffic until it\'s healthy; until then, blue serves everyone.',
    },
    {
      question: 'The 5xx alarm goes off during the deploy. What does CodeDeploy do?',
      options: ['Sends traffic back to blue', 'Deletes blue', 'Restarts the pipeline', 'Turns off the load balancer'],
      answer: 0,
      why: 'Blue is still running, so rolling back is just pointing the traffic at it again.',
    },
    {
      question: 'Why does a canary release cause far fewer errors?',
      options: ['It deploys at night', 'It uses smaller tasks', 'Only 10% of traffic sees the new version while the alarm decides', 'It skips the health checks'],
      answer: 2,
      why: 'Fewer people see a bad version, and for less time.',
    },
  ],
}

export default lesson
