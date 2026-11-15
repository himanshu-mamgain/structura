import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: '"It works on my machine"',
      text: 'Your app needs the right version of Node.js or Python, the right libraries and the right settings. On another computer one of those is different, and the app breaks. Virtual machines and containers both fix this the same way: they pack the app together with everything it needs.',
      focus: ['App + Libs in VM', 'Containers (App + Libs)'],
      remember: 'Both carry your app and its libraries, so it runs the same everywhere.',
    },
    {
      title: 'A virtual machine is a whole computer in software',
      text: 'A hypervisor is software that splits one real server into several pretend computers, called virtual machines (VMs). Each VM gets its own share of CPU and memory, and boots its own complete operating system, called the guest OS.',
      focus: ['Server Hardware', 'Hypervisor (KVM, ESXi)', 'Guest OS per VM'],
    },
    {
      title: 'Why VMs are heavy',
      text: 'Every guest OS needs its own memory and disk, and boots like a real computer, which can take a minute. Ten VMs means ten operating systems to run, update and patch, before your apps even start.',
      focus: ['Guest OS per VM', 'App + Libs in VM'],
      remember: 'A VM has strong walls, because it shares only the hardware. The price is weight.',
    },
    {
      title: 'A container shares the host\'s kernel',
      text: 'The kernel is the core of an operating system: it runs programs and talks to the hardware. All the containers on one machine share the host\'s kernel. Docker Engine starts each app as a normal process, with walls around it.',
      focus: ['Host Hardware', 'Host OS (one kernel)', 'Docker Engine'],
      remember: 'No guest OS to boot, so a container starts in under a second and uses little memory.',
    },
    {
      title: 'Namespaces and cgroups build the walls',
      text: 'Two Linux features do the isolating. Namespaces decide what a process can see: its own files, network and list of processes. Cgroups (control groups) decide how much it can use: CPU and memory.',
      focus: ['Namespaces + cgroups', 'Containers (App + Libs)'],
      example: 'docker run --memory=512m --cpus=1 shop-api:1.4',
      remember: 'Namespaces: what it can see. Cgroups: how much it can use.',
    },
    {
      title: 'A Dockerfile is the recipe',
      text: 'You write the steps to build your app\'s box in a Dockerfile: start from a base image, copy in the code, install packages, and say which command starts the app.',
      focus: ['Dockerfile'],
      example: 'FROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nCMD ["node", "server.js"]',
    },
    {
      title: 'An image is built in layers',
      text: '"docker build" follows the recipe and saves the result as an image: a read-only template made of layers, one for each step. If a step and everything above it did not change, Docker reuses that layer from its cache, so rebuilds are quick.',
      focus: ['Dockerfile', 'Image (layers)'],
      example: 'docker build -t shop-api:1.4 .',
      remember: 'Copy package.json and install packages before copying the code, so a code change doesn\'t reinstall everything.',
    },
    {
      title: 'A registry stores and shares images',
      text: 'You push the image to a registry, such as Docker Hub or Amazon ECR. Any server can then pull the same image and run it, so testing and production run exactly the same thing.',
      focus: ['Image (layers)', 'Registry', 'Docker Engine'],
      example: 'docker push registry.example.com/shop-api:1.4\ndocker pull registry.example.com/shop-api:1.4',
    },
    {
      title: 'Which one to use',
      text: 'Use containers for most apps: they are light, start fast, and many fit on one server. Use a VM when you need a different operating system, such as Windows on a Linux host, or stronger walls around code you don\'t trust. In the cloud, your containers usually run inside VMs.',
      remember: 'Containers share a kernel. VMs share only the hardware.',
    },
  ],
  quiz: [
    {
      question: 'What do all the containers on one server share?',
      options: ['A guest operating system each', 'The host\'s kernel', 'One memory limit', 'Nothing at all'],
      answer: 1,
      why: 'Containers are walled-off processes on one shared kernel. It\'s VMs that each boot their own guest OS.',
    },
    {
      question: 'You change one line of code and rebuild the image. Why can the build be quick?',
      options: ['The registry builds it for you', 'Docker skips the Dockerfile', 'Docker reuses the cached layers of steps that didn\'t change', 'Containers don\'t need images'],
      answer: 2,
      why: 'Each Dockerfile step makes a layer. Steps above the change, like installing packages, come straight from the cache.',
    },
    {
      question: 'Which job needs a virtual machine rather than a container?',
      options: ['Running a Windows program on a Linux server', 'Running 20 copies of a Node.js API', 'Shipping the same build to test and production', 'Starting an app in under a second'],
      answer: 0,
      why: 'A container uses the host\'s kernel, so it must suit that operating system. A VM boots its own OS, so it can run Windows on Linux hardware.',
    },
  ],
}

export default lesson
