import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'From an image to a running app',
      text: 'You have a container image. Now something has to run copies of it, replace any that crash, and add more when traffic grows. On AWS, that is ECS (Elastic Container Service).',
      focus: ['ECS Service', 'Fargate Task (zone a)', 'Fargate Task (zone b)'],
    },
    {
      title: 'Fargate: no servers to patch',
      text: 'With Fargate, AWS gives every running copy, called a task, its own small virtual machine. You choose CPU and memory for each task and pay by the second. There are no servers for you to update.',
      focus: ['Fargate Task (zone a)', 'Fargate Task (zone b)'],
      example: '0.5 vCPU + 1 GB ≈ $0.0247 an hour ≈ $18 a month per task',
    },
    {
      title: 'What 0.25 vCPU means',
      text: 'A vCPU is one hardware thread of a real processor: about half a core on Intel and AMD, a whole core on Graviton. A 0.25 vCPU task gets a quarter of its time, about 25 ms in every 100 ms. Need more? The task waits and gets slow, but it does not crash.',
      focus: ['Fargate Task (zone a)'],
      example: 'CPU units: 1,024 = 1 vCPU, so "cpu": "256" = 0.25 vCPU\n0.25 vCPU = 250 ms of CPU each second\nat 2.5 ms a request → about 100 requests a second',
      remember: 'Too little CPU makes a task slow; too little memory gets it killed.',
    },
    {
      title: 'The task definition is the recipe',
      text: 'A task definition says which image to run, how much CPU and memory, which ports, which secrets, and where the logs go. Every change makes a new numbered revision, so you can always go back.',
      focus: ['Task Definition', 'ECR Repository'],
    },
    {
      title: 'A service keeps copies running',
      text: 'A service keeps the number of tasks you ask for, called the desired count, running across zones. If a task crashes, the service starts a new one and adds it to the load balancer.',
      focus: ['ECS Service', 'Fargate Task (zone a)', 'Fargate Task (zone b)', 'Load Balancer'],
    },
    {
      title: 'Secrets and logs',
      text: 'Passwords live in Secrets Manager, not in the image. ECS hands them to the task when it starts. Whatever the app prints goes to CloudWatch Logs.',
      focus: ['Fargate Task (zone a)', 'Secrets Manager', 'CloudWatch Logs'],
    },
    {
      title: 'Scaling on CPU',
      text: 'Every minute, a scaling rule compares the tasks\' average CPU with a target, here 50%, and changes the desired count. A new task takes about two minutes to start, so before a planned sale, raise the minimum ahead of time.',
      focus: ['CloudWatch Metrics', 'CPU Above Target?', 'ECS Service'],
      example: 'One 0.5-vCPU task serves 200 requests/s at 100% CPU\nSale: 1,200 ÷ (200 × 0.5) = 12 tasks at 50%',
    },
    {
      title: 'Rolling deploys',
      text: 'To ship a new version, the pipeline pushes the image to ECR and registers a new revision. The service starts new tasks, waits until they are healthy, then stops the old ones, so nobody sees downtime.',
      focus: ['Deploy Pipeline', 'ECR Repository', 'Task Definition', 'ECS Service'],
    },
    {
      title: 'The circuit breaker rolls back',
      text: 'If new tasks keep failing to start, the deployment circuit breaker counts the failures. Past a limit, it stops the deploy and goes back to the last working revision by itself.',
      focus: ['New Tasks Healthy?', 'Task Definition'],
      example: 'Limit = the larger of 3 and half the desired count (rounded up)\n2 tasks → 3 failures; 10 tasks → 5',
    },
  ],
  quiz: [
    {
      question: 'What does an ECS service do when a task crashes?',
      options: ['Nothing, until someone restarts it', 'Starts a new one to get back to the desired count', 'Deletes the task definition', 'Moves the app to another region'],
      answer: 1,
      why: 'Keeping the desired count running, and replacing what fails, is the service\'s main job.',
    },
    {
      question: 'Where should the database password live?',
      options: ['In the Dockerfile', 'In the task definition as plain text', 'In the app\'s code', 'In Secrets Manager, handed to the task when it starts'],
      answer: 3,
      why: 'Anything inside an image or a plain task definition can be read by anyone who can read those.',
    },
    {
      question: 'A big sale starts at 8 pm. Why raise the minimum task count before it?',
      options: ['New tasks take minutes to start, so reacting once the rush begins is too late', 'Fargate costs less in the evening', 'The circuit breaker needs it', 'ECR stops working during sales'],
      answer: 0,
      why: 'Scaling reacts to CPU a minute at a time, and each task needs about two minutes to start.',
    },
  ],
}

export default lesson
