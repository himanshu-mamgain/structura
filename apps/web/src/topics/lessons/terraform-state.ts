import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'One memory, many people',
      text: 'Terraform remembers what it manages in a state file. By default, that file sits on the laptop of whoever ran Terraform, and nobody else can see it. On a team, everyone must use the same copy.',
      focus: ['Priya', 'Laptop State File'],
    },
    {
      title: 'What goes wrong on a laptop',
      text: 'Priya created a Redis cache, and only her laptop\'s state knows about it. When Arjun runs Terraform with his own state, his run has no idea the cache exists. It may create a second one, and the two states never agree again.',
      focus: ['Priya', 'Arjun', 'Laptop State File', 'Redis Cache'],
    },
    {
      title: 'A remote backend shares it',
      text: 'A backend is where the state lives. With the S3 backend, everyone\'s "terraform init" connects to the same state file in one S3 bucket, stored encrypted.',
      focus: ['S3 State Bucket', 'Priya', 'Arjun', 'CI Runner'],
      example: 'terraform {\n  backend "s3" {\n    bucket       = "food-app-tf-state"\n    key          = "prod/terraform.tfstate"\n    region       = "ap-south-1"\n    encrypt      = true\n    use_lockfile = true\n  }\n}',
    },
    {
      title: 'A lock stops two runs at once',
      text: 'Before reading the state, each run takes a lock. While Priya holds it, Arjun\'s run waits or stops with a message, instead of both writing at once.',
      focus: ['Priya', 'Arjun', 'Lock File'],
      example: 'Error: Error acquiring the state lock\nLock Info:\n  Operation: OperationTypeApply\n  Who:       priya@laptop',
    },
    {
      title: 'How two writes lose work',
      text: 'Without a lock, both runs read the same state. Arjun\'s finishes first and saves it with his new IAM role. Priya\'s finishes later and saves her copy, which has no role in it. The role still exists, but no state knows about it.',
      focus: ['Arjun', 'IAM Role', 'S3 State Bucket'],
    },
    {
      title: 'Versioning keeps every copy',
      text: 'Turn on versioning for the state bucket. Every write is kept, so if the state is damaged or overwritten, you can bring back an earlier one.',
      focus: ['S3 State Bucket', 'Older State Versions'],
      remember: 'State files are small: years of history cost only cents.',
    },
    {
      title: 'When a run dies halfway',
      text: 'If an apply is killed, say a laptop lid closes, the lock may stay behind, and the state may miss what was just created. Check that nobody is running, remove the lock with force-unlock, and bring the missing resource in with import.',
      focus: ['Lock File', 'Redis Cache', 'AWS Resources'],
      example: 'terraform force-unlock <LOCK_ID>\nterraform import aws_elasticache_cluster.cache food-app-cache',
    },
    {
      title: 'Let CI apply',
      text: 'Best of all, people only run plan, and the CI runner applies changes once they are reviewed and merged. One writer, and every change is checked first.',
      focus: ['CI Runner', 'Lock File', 'AWS Resources'],
    },
  ],
  quiz: [
    {
      question: 'Why is a state file on a laptop a problem for a team?',
      options: ['Nobody else can see it, so their runs don\'t know what exists', 'Laptops can\'t run Terraform', 'It\'s too big', 'AWS won\'t accept it'],
      answer: 0,
      why: 'Each person\'s Terraform only knows what its own state records.',
    },
    {
      question: 'Priya is applying, and Arjun runs apply too. With a lock, what happens?',
      options: ['Both write, and the newest wins', 'Arjun\'s run waits or stops until the lock is free', 'Priya\'s run is cancelled', 'Terraform merges both'],
      answer: 1,
      why: 'Only one run can hold the lock, so only one can read and write the state at a time.',
    },
    {
      question: 'The state was overwritten by mistake. What gets it back?',
      options: ['terraform plan', 'Deleting the lock', 'Restoring the previous version from S3 versioning', 'Running apply twice'],
      answer: 2,
      why: 'With versioning on, every earlier state is still in the bucket.',
    },
  ],
}

export default lesson
