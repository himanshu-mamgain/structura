import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Three environments, one design',
      text: 'Most apps run in dev, staging and prod. They should be built the same way, just at different sizes. Copying the same files three times means typing every change three times, and the copies slowly drift apart.',
      focus: ['Dev Stack', 'Staging Stack', 'Prod Stack'],
      example: 'Copied folders: about 420 lines × 3\nA versioned module: the module once, plus about 15 lines per environment',
    },
    {
      title: 'A module is a reusable building block',
      text: 'A module is a folder of .tf files with inputs (variables) and outputs. This service module builds the network, load balancer, ECS service and database. Each environment calls it with its own inputs.',
      focus: ['Service Module'],
      example: 'module "service" {\n  source        = "git::https://github.com/food-app/tf-service.git?ref=v1.5.0"\n  env           = "dev"\n  desired_count = 1\n}',
    },
    {
      title: 'Give the module versions',
      text: 'When you change the module, tag a new version, such as v1.5.0. Each environment says which version it uses, so a change only reaches an environment when you choose.',
      focus: ['Engineer', 'Service Module', 'Module Versions'],
    },
    {
      title: 'One root and one state per environment',
      text: 'Each environment has its own small configuration, called its root, and its own state file. A mistake while applying dev can only touch dev.',
      focus: ['Dev Config', 'Dev State', 'Dev Stack'],
      remember: 'Separate state keeps the blast radius small: the damage one mistake can do.',
    },
    {
      title: 'Promote: dev, then staging, then prod',
      text: 'Move a new version through the environments one at a time. Dev gets it on Monday, staging on Tuesday, prod on Wednesday, so each version has a day of real use before it reaches prod.',
      focus: ['Module Versions', 'Dev Config', 'Staging Config', 'Prod Config'],
    },
    {
      title: 'Prod stays pinned',
      text: 'Until it\'s prod\'s turn, prod keeps the version it has tested, v1.4.0 here, whatever happens in dev.',
      focus: ['Prod Config', 'Prod State', 'Prod Stack'],
    },
    {
      title: 'Only CI changes prod',
      text: 'People can plan prod, but only the CI pipeline may apply it, after review. With one writer, nobody changes prod by surprise from a laptop.',
      focus: ['CI Pipeline', 'Prod Config', 'Prod State'],
      remember: 'Add prevent_destroy to resources that must never be deleted, like the database.',
    },
    {
      title: 'Why not workspaces?',
      text: 'Terraform workspaces give each environment its own state, but they all run the same code at the same version. You can\'t keep prod on the old version while dev tries the new one.',
      focus: ['Dev Config', 'Prod Config'],
    },
  ],
  quiz: [
    {
      question: 'Why tag versions of the module?',
      options: ['So each environment gets a change only when you choose', 'Terraform won\'t run untagged code', 'Tags make apply faster', 'To share state between environments'],
      answer: 0,
      why: 'Each environment points at a version, so you decide when it moves to the next one.',
    },
    {
      question: 'A mistake is applied in dev. With one state per environment, what can it affect?',
      options: ['Every environment', 'Only dev', 'Dev and staging', 'Only prod'],
      answer: 1,
      why: 'Dev\'s apply reads and writes only dev\'s state, so it can only change dev\'s resources.',
    },
    {
      question: 'What\'s the problem with using workspaces for dev and prod?',
      options: ['They can\'t have separate state', 'They cost more', 'They all use the same code version, so prod can\'t stay on the old one', 'They don\'t work with AWS'],
      answer: 2,
      why: 'Workspaces separate state, not code, so you can\'t promote a version step by step.',
    },
  ],
}

export default lesson
