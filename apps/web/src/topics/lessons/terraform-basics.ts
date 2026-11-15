import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Infrastructure as code',
      text: 'Instead of clicking through the AWS console, you describe what you want in files, and a tool makes it real. Terraform is that tool. The files can be reviewed, kept in Git, and run again to get the same result.',
      focus: ['Engineer', 'Your .tf Files'],
    },
    {
      title: 'Resources and providers',
      text: 'You write .tf files in HCL, Terraform\'s language. Each resource block describes one thing you want, like a server or a bucket. A provider is a plugin that knows how to talk to one API, such as AWS.',
      focus: ['Your .tf Files', 'AWS Provider'],
      example: 'resource "aws_s3_bucket" "menus" {\n  bucket = "food-app-menu-photos"\n}',
    },
    {
      title: 'References set the order',
      text: 'When one resource uses another\'s value, like a subnet using the VPC\'s ID, Terraform knows the VPC must come first. From these references it builds a dependency graph, and it creates things that don\'t depend on each other at the same time.',
      focus: ['Terraform Core', 'Dependency Graph'],
      example: 'resource "aws_subnet" "app" {\n  vpc_id     = aws_vpc.main.id\n  cidr_block = "10.0.1.0/24"\n}',
    },
    {
      title: 'State is Terraform\'s memory',
      text: 'The state file records which real resource belongs to each block in your code, with its real ID. Without it, Terraform can\'t tell that a server already exists, and would make a second one.',
      focus: ['State File', 'Terraform Core'],
      example: 'A duplicate m6i.large from a lost state file:\n$0.101 × 720 hours ≈ $73 a month, until someone notices',
    },
    {
      title: 'Plan shows what will change',
      text: '"terraform plan" checks the real resources, compares them with your code, and lists what it would do. Nothing changes yet.',
      focus: ['Your .tf Files', 'State File', 'Plan'],
      example: '+    create\n~    update in place\n-/+  destroy, then create again\n-    destroy',
      remember: 'Read every -/+ line carefully: the old resource will be deleted.',
    },
    {
      title: 'Apply makes it real',
      text: '"terraform apply" runs the plan. The AWS provider calls AWS\'s APIs in the graph\'s order, and when it\'s done, Terraform writes the new state.',
      focus: ['Terraform Core', 'AWS Provider', 'AWS APIs', 'VPC', 'Subnet', 'EC2 Instance'],
    },
    {
      title: 'Update in place, or replace',
      text: 'Some changes can be made to a running resource; others can\'t. Changing a server\'s size is a stop, change and start, about a minute. Changing its machine image destroys the old server and creates a new one.',
      focus: ['Plan', 'EC2 Instance'],
    },
    {
      title: 'Drift: when someone clicks',
      text: 'If someone changes a resource by hand in the console, the real thing no longer matches the code. The next plan shows the difference, and apply puts it back the way the code says.',
      focus: ['AWS APIs', 'Security Group', 'Plan'],
      remember: 'Make every change in code. Changes made by hand get undone.',
    },
  ],
  quiz: [
    {
      question: 'What is the state file for?',
      options: ['It maps each resource in your code to the real one, with its ID', 'It stores your AWS password', 'It backs up your servers\' data', 'It lists the providers to download'],
      answer: 0,
      why: 'It\'s how Terraform knows what already exists and what it manages.',
    },
    {
      question: 'A plan line starts with -/+. What will happen?',
      options: ['The resource is updated in place', 'The resource is destroyed and created again', 'Nothing', 'A new copy is added and the old one kept'],
      answer: 1,
      why: 'Some settings can\'t change on a running resource, so Terraform replaces it.',
    },
    {
      question: 'Someone opened a port by hand in the console. What does the next apply do?',
      options: ['Keeps the change', 'Deletes the security group for good', 'Puts it back the way the code says', 'Fails until someone undoes it by hand'],
      answer: 2,
      why: 'The code is the source of truth. Plan shows the drift, and apply removes it.',
    },
  ],
}

export default lesson
