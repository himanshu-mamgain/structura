import type { StaticTopic } from './types'

export const dockerVsVm: StaticTopic = {
  difficulty: 'Beginner',
  kind: 'static',
  id: 'docker-vs-vm',
  title: 'Docker vs Virtual Machines',
  blurb: 'Hypervisors vs shared kernels, images, layers, and when to use which',
  video: '/videos/docker-vs-vm.mp4',
  chapters: [
    [0, "Introduction"],
    [4, "The classic problem"],
    [11, "Virtual machines"],
    [31, "Containers"],
    [51, "Side by side"],
    [65, "When to use which"],
    [79, "Dockerfile to container"],
    [89, "Recap"],
  ],
  guides: [
    "ref-docker-curriculum",
    "primer-application-layer",
    "how-does-docker-work",
    "top-8-must-know-docker-concepts",
    "9-docker-best-practices-you-must-know",
    "what-is-k8s-kubernetes",
  ],
  takeaways: [
    "A VM virtualizes hardware and boots its own OS; a container is an isolated process on a shared kernel.",
    "Namespaces give a container its own view; cgroups limit what it can use.",
    "Containers are megabytes and start in about a second; VMs are gigabytes and take far longer.",
    "VMs isolate better: every guest has its own kernel.",
    "Images are layered and cached: order a Dockerfile from least to most often changed.",
    "In the cloud, containers usually run inside VMs.",
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'vm', label: 'Virtual machines' },
      { id: 'ct', label: 'Containers' },
      { id: 'build', label: 'Build and ship' },
    ],
    nodes: [
      { id: 'hw1', label: 'Server Hardware', shape: 'rectangle', color: 'grey', group: 'vm' },
      { id: 'hyp', label: 'Hypervisor (KVM, ESXi)', shape: 'rectangle', color: 'violet', group: 'vm' },
      { id: 'guest', label: 'Guest OS per VM', shape: 'rectangle', color: 'orange', group: 'vm' },
      { id: 'appvm', label: 'App + Libs in VM', shape: 'rectangle', color: 'green', group: 'vm' },
      { id: 'hw2', label: 'Host Hardware', shape: 'rectangle', color: 'grey', group: 'ct' },
      { id: 'hostos', label: 'Host OS (one kernel)', shape: 'rectangle', color: 'orange', group: 'ct' },
      { id: 'engine', label: 'Docker Engine', shape: 'rectangle', color: 'blue', group: 'ct' },
      { id: 'iso', label: 'Namespaces + cgroups', shape: 'diamond', color: 'light-blue', group: 'ct' },
      { id: 'appct', label: 'Containers (App + Libs)', shape: 'rectangle', color: 'green', group: 'ct' },
      { id: 'dockerfile', label: 'Dockerfile', shape: 'rectangle', color: 'white', group: 'build' },
      { id: 'image', label: 'Image (layers)', shape: 'rectangle', color: 'light-blue', group: 'build' },
      { id: 'registry', label: 'Registry', shape: 'hexagon', color: 'yellow', group: 'build' },
    ],
    edges: [
      { from: 'hw1', to: 'hyp', label: 'split by', dashed: false },
      { from: 'hyp', to: 'guest', label: 'boots each', dashed: false },
      { from: 'guest', to: 'appvm', label: 'runs', dashed: false },
      { from: 'hw2', to: 'hostos', label: 'runs', dashed: false },
      { from: 'hostos', to: 'engine', label: 'runs', dashed: false },
      { from: 'engine', to: 'iso', label: 'sets up', dashed: false },
      { from: 'iso', to: 'appct', label: 'isolated processes', dashed: false },
      { from: 'dockerfile', to: 'image', label: 'docker build', dashed: false },
      { from: 'image', to: 'registry', label: 'docker push', dashed: false },
      { from: 'registry', to: 'engine', label: 'docker pull', dashed: true },
    ],
  },
  database: null,
  explanation: {
    title: 'Docker vs Virtual Machines',
    summary:
      'A virtual machine emulates a whole computer and boots its own operating system. A container is an isolated process that shares the host\'s kernel. VMs give stronger isolation; containers are far lighter and start in about a second.',
    sections: [
      {
        heading: 'Overview',
        body: 'Both solve "it works on my machine": they package an app with everything it needs so it runs the same everywhere. They differ in where the line between app and machine is drawn.\n- A VM virtualizes hardware. A hypervisor splits one physical server into several virtual ones, and each runs a complete guest OS.\n- A container virtualizes the operating system. All containers share the host\'s Linux kernel; the kernel just gives each one its own view of the system.',
      },
      {
        heading: 'Step by step',
        body: '1. Write a Dockerfile: the recipe (base image, dependencies, your code, start command).\n2. docker build turns it into an Image (layers): read-only, cached layers, one per instruction.\n3. docker push uploads the image to a Registry (Docker Hub, ECR, GCR).\n4. On any server, the Docker Engine pulls the image.\n5. docker run asks the kernel for Namespaces + cgroups and starts your process inside them: Containers (App + Libs).\n\nThe VM path, for comparison: Server Hardware is split by the Hypervisor (KVM, ESXi), which boots a Guest OS per VM, which then runs the App + Libs in VM.',
      },
      {
        heading: 'How containers isolate',
        body: '- Namespaces give a process its own view: its own process list (pid), network interfaces (net), filesystem mounts (mnt), hostname (uts), and users (user).\n- cgroups limit what it can use: CPU, memory, disk I/O, number of processes.\n- The image\'s layers are stacked with a union filesystem (overlayfs), plus a thin writable layer per container.\n\nThere is no second kernel: a container is a normal Linux process with restrictions. That is why it starts in about a second and why one server can run hundreds.',
      },
      {
        heading: 'Side by side',
        body: '- Size: a VM image carries a full OS, typically gigabytes. A container image carries only the app and its libraries, typically tens to hundreds of megabytes.\n- Start time: a VM boots an OS, often tens of seconds to minutes. A container starts a process, usually under a second.\n- Density: tens of VMs per server versus hundreds of containers.\n- Isolation: a VM has its own kernel, so a kernel exploit in one guest does not reach the others. Containers share one kernel, so a kernel bug can affect all of them.\n- OS choice: a VM can run Windows on a Linux host. A Linux container needs a Linux kernel.',
      },
      {
        heading: 'When to use which',
        body: '- VMs: a different OS, strong isolation between untrusted tenants, legacy apps that expect a full machine.\n- Containers: microservices, the same image from laptop to CI to production, fast scaling.\n- Both, very often: cloud containers usually run inside VMs, and Docker Desktop on Windows and macOS runs a small Linux VM to provide the kernel. Lightweight VMs like Firecracker (AWS Lambda, Fargate) combine VM-level isolation with near-container start times.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- Why can\'t a Linux container run a Windows app natively?\n- What do layers buy you when 50 images share the same base?\n- How would you run untrusted user code safely: containers, gVisor, or microVMs?\n- What happens to a container\'s files when it is deleted, and how do volumes help?\n- Why do Kubernetes nodes run in VMs in most clouds?',
      },
    ],
    trace: {
      input: 'Shipping a Python web app with Docker',
      steps: [
        { text: 'The Dockerfile is the recipe: start from a small Python image, install dependencies, copy the code, set the start command.', nodes: ['Dockerfile'], data: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\nCOPY . .\nCMD ["python", "main.py"]' },
        { text: 'docker build runs each instruction and saves the result as a layer. Layers are cached, so changing only your code rebuilds only the last layers.', nodes: ['Dockerfile', 'Image (layers)'], data: '$ docker build -t shop/api:1.4 .\n => [1/4] FROM python:3.12-slim        CACHED\n => [2/4] COPY requirements.txt .        CACHED\n => [3/4] RUN pip install …              CACHED\n => [4/4] COPY . .                       0.3s\n => naming to shop/api:1.4' },
        { text: 'docker push uploads only the layers the Registry does not have yet.', nodes: ['Image (layers)', 'Registry'], data: '$ docker push shop/api:1.4\n7d1f…: Layer already exists\n3a8c…: Layer already exists\n91be…: Pushed\n1.4: digest: sha256:4c2e… size: 1789' },
        { text: 'On the server, the Docker Engine pulls the image, again skipping layers it already has.', nodes: ['Registry', 'Docker Engine'], data: '$ docker pull shop/api:1.4\n1.4: Pulling from shop/api\n91be…: Pull complete\nStatus: Downloaded newer image for shop/api:1.4' },
        { text: 'docker run asks the kernel for new namespaces and a cgroup with limits, then starts the process inside them.', nodes: ['Docker Engine', 'Namespaces + cgroups', 'Host OS (one kernel)'], data: '$ docker run -d --memory 512m --cpus 1 -p 8080:8080 shop/api:1.4\n\nnamespaces: pid, net, mnt, uts, ipc\ncgroup: memory.max = 512M, cpu.max = 100000 100000' },
        { text: 'The container is just a Linux process on the shared kernel. It starts in about a second, and inside it sees only itself.', nodes: ['Containers (App + Libs)'], data: '$ docker exec <id> ps\n  PID  CMD\n    1  python main.py\n\n# On the host the same process has an ordinary PID, e.g. 48213.' },
        { text: 'The same app in a VM: the Hypervisor (KVM, ESXi) gives it virtual hardware, and a full Guest OS per VM has to boot before the app can start.', nodes: ['Server Hardware', 'Hypervisor (KVM, ESXi)', 'Guest OS per VM'], data: 'VM: 2 vCPU, 4 GB RAM, 20 GB disk\nboot: firmware → kernel → systemd → app\n≈ 30–60 s, ≈ 2 GB of OS per VM' },
        { text: 'Each VM carries its own kernel: heavier, but a kernel bug in one guest does not reach the others.', nodes: ['Guest OS per VM', 'App + Libs in VM'], data: null },
      ],
    },
    code: [
      {
        title: 'Dockerfile (cache-friendly order)',
        language: 'bash',
        source: `# Dockerfile: dependencies before code, so editing code
# doesn't reinstall packages on every build.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Run as a non-root user inside the container.
RUN useradd --create-home app
USER app
EXPOSE 8080
CMD ["python", "main.py"]`,
      },
      {
        title: 'Containers are just processes',
        language: 'bash',
        source: `# Build, then run with resource limits (enforced by cgroups).
docker build -t shop/api:1.4 .
docker run -d --name api --memory 512m --cpus 1 -p 8080:8080 shop/api:1.4

# Inside: its own process list (pid namespace), so the app is PID 1.
docker exec api ps

# Outside: the same app is an ordinary process on the host kernel.
ps -ef | grep "python main.py"

# Without Docker: a shell in new pid + mount namespaces (Linux, as root).
sudo unshare --pid --fork --mount-proc bash -c 'ps'`,
      },
    ],
    related: ['Kubernetes', 'Microservices', 'CI/CD pipelines', 'Serverless', 'Multi-tenancy'],
  },
}
