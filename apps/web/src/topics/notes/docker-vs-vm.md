# Docker: Containers, Images, Dockerfiles, Volumes, Networks and Compose

> 💡 **TL;DR**: A **container** is your app running as an isolated process on a shared Linux kernel. It brings its own files and libraries, but not its own operating system. An **image** is the read-only template a container starts from: stacked, cached **layers** plus a start command. You write the image's recipe in a **Dockerfile**, keep data that must survive in a **volume**, connect containers over a **network** where they find each other by name, and start a whole stack with one **Compose** file. A **virtual machine** is the heavier cousin: it boots a whole operating system with its own kernel. That makes it slower and bigger, but better isolated.

This is where the roadmap starts: everything later (ECS, Kubernetes, CI/CD) runs these images. Next, [ECS on Fargate](/?topic=aws-ecs-fargate&read) runs them on AWS.

---

## Docker at a glance

| Term | What it is | You meet it as |
| --- | --- | --- |
| Image | A read-only template: filesystem layers plus config (start command, env, user) | `node:22-slim`, `shop/api:1.4` |
| Container | A running (or stopped) instance of an image: an isolated process plus a thin writable layer | `docker run`, `docker ps` |
| Dockerfile | The recipe that builds an image, one instruction per line | `FROM`, `RUN`, `COPY`, `CMD` |
| Layer | The filesystem change made by one instruction, cached and shared between images | `docker history shop/api:1.4` |
| Registry | Where images are stored and shared | Docker Hub, Amazon ECR, GitHub Container Registry |
| Tag / digest | A movable name / an unchangeable content hash | `shop/api:1.4` / `shop/api@sha256:4c2e…` |
| Volume | Storage that outlives the container | `-v pgdata:/var/lib/postgresql/data` |
| Network | How containers reach each other and the outside world | `-p 8080:3000`, `docker network create` |
| Compose | Several containers described in one YAML file | `compose.yaml`, `docker compose up` |

---

## Why containers exist

The classic bug report: "it works on my machine". Your laptop has Node 22, the server has Node 18. Your laptop has one OpenSSL, the server another. A system library is missing, an environment variable is set differently.

A container image packs the app **and everything it needs except the kernel**: the runtime, system libraries, your `node_modules`, config defaults and the start command. The same image then runs the same way on your laptop, in CI and in production. Deploying stops meaning "set up the server" and becomes "run this image".

---

## Container vs virtual machine

```text
Virtual machines                          Containers
┌──────────┬──────────┐                   ┌──────────┬──────────┐
│ App A    │ App B    │                   │ App A    │ App B    │
│ Libs     │ Libs     │                   │ Libs     │ Libs     │
│ Guest OS │ Guest OS │ ← a kernel each   ├──────────┴──────────┤
├──────────┴──────────┤                   │ Container runtime   │
│ Hypervisor          │                   │ Host OS (one kernel)│
│ Hardware            │                   │ Hardware            │
└─────────────────────┘                   └─────────────────────┘
```

| | Virtual machine | Container |
| --- | --- | --- |
| What is virtualised | The hardware: CPU, memory, disk, network card | The operating system's view: processes, files, network, hostname |
| Kernel | Its own, one per VM | Shared with the host |
| Size | Gigabytes (a whole OS) | Megabytes to a few hundred MB |
| Start time | Tens of seconds to minutes: it boots an OS | Usually under a second: it starts a process |
| Isolation | Strong: the hypervisor is a small, hard boundary | Weaker: a kernel bug can reach the host |
| Density | Tens per server | Hundreds per server |
| Runs | Any OS (Windows on a Linux host, and so on) | Linux containers need a Linux kernel |

- A **hypervisor** splits one physical machine into VMs. Type 1 runs on the hardware (KVM, ESXi, Hyper-V, Xen; EC2 runs on AWS's KVM-based Nitro). Type 2 runs as an app on your OS (VirtualBox, VMware Workstation).
- On a Mac or Windows laptop, **Docker Desktop runs a small Linux VM** and your containers run inside it. That's why file mounts there are slower than on Linux.
- In the cloud, containers usually run **inside VMs** anyway: an EC2 instance hosts the containers. You get the VM's isolation between customers and the container's speed inside.
- **Sandboxes** sit in between. Firecracker microVMs (built by AWS for Lambda) and Kata Containers give each container its own tiny VM; gVisor puts a kernel written in user space in front of it. They start almost as fast as containers and are what you use to run untrusted code.

---

## How isolation works: namespaces and cgroups

A container is not a special object in the kernel. It is an ordinary process started with three things set up around it.

**Namespaces** decide what the process can **see**:

| Namespace | Gives the container its own… | So that |
| --- | --- | --- |
| `pid` | Process tree | Your app is PID 1 and can't see host processes |
| `net` | Network interfaces, IP address, ports | Two containers can both listen on port 3000 |
| `mnt` | Filesystem tree | It sees the image's files, not the host's |
| `uts` | Hostname | `hostname` prints the container id |
| `ipc` | Shared memory and message queues | One container can't read another's shared memory |
| `user` | User ids | Root inside can map to an unprivileged user outside (rootless mode) |
| `cgroup` | View of its cgroup tree | It can't see the host's resource groups |

**cgroups** (control groups) decide what it can **use**: memory, CPU time, number of processes, disk I/O. `--memory 512m` writes `memory.max = 512M`. Go over it and the kernel's OOM killer ends the process (exit code 137).

**A layered filesystem** (the `overlay2` driver) gives it files: the image's read-only layers stacked up, plus one thin **writable layer** per container. Changing a file from a lower layer first copies it up into the writable layer (**copy-on-write**). Ten containers from one image share the same layers on disk. `docker rm` deletes the writable layer and anything written there.

On top of that, Docker drops most Linux **capabilities** (root inside can't load kernel modules or change the clock) and applies a **seccomp** profile that blocks risky system calls.

```bash
# Inside: its own process list. The app is PID 1.
docker run --rm alpine ps
#   PID   USER     COMMAND
#     1   root     ps

# Same idea without Docker: a shell in new pid + mount namespaces (Linux, as root)
sudo unshare --pid --fork --mount-proc bash -c 'ps'
```

---

## What happens on docker run

1. The `docker` CLI sends the request to the Docker daemon (`dockerd`) over its API socket, `/var/run/docker.sock`.
2. If the image isn't on the machine, the daemon pulls it from the registry: first the **manifest** (the list of layers), then only the layers it doesn't already have, each checked against its sha256 digest.
3. The layers are stacked with overlayfs into a root filesystem, and the daemon hands an OCI bundle (that filesystem plus a `config.json`) to **containerd**.
4. containerd starts a small **shim**, which runs **runc**. runc creates the namespaces and the cgroup with your limits, switches the root filesystem, drops capabilities and starts your `CMD` as PID 1. Then runc exits. The shim stays as the parent, so restarting the daemon doesn't kill your containers.
5. Networking: Docker makes a **veth pair**, a virtual cable. One end is `eth0` inside the container (say `172.17.0.2`), the other plugs into the `docker0` bridge. `-p 8080:3000` adds a NAT rule: traffic to the host's port 8080 goes to the container's port 3000.
6. Whatever the app writes to stdout and stderr goes to a logging driver (`json-file` by default), which is what `docker logs` reads.

---

## Images and layers

- An image is an **ordered list of layers plus a JSON config** (command, env, user, exposed ports). `RUN`, `COPY` and `ADD` add layers; `ENV`, `CMD`, `EXPOSE` and the like only change the config.
- Layers are named by the sha256 of their content, so they're **shared and cached**: two images on `node:22-slim` store its layers once, and a push or pull only moves the layers the other side is missing.
- **Tags move, digests don't.** `latest` is just the default tag name, not "the newest". It points wherever someone last pushed it. In production, pin a version (`node:22.11-slim`) or a digest (`node@sha256:…`), and tag your own images with the git commit (`shop/api:3f9c2ab`).
- **One tag, many CPUs.** A multi-platform image is an index pointing at an `amd64` and an `arm64` build. Apple Silicon laptops and AWS Graviton servers are arm64. Build both with `docker buildx build --platform linux/amd64,linux/arm64 --push`.

```bash
docker image ls                       # images on this machine and their sizes
docker history shop/api:1.4           # each layer, the instruction that made it, its size
docker image inspect shop/api:1.4     # config: Cmd, Env, User, ExposedPorts, layer digests
```

---

## Writing a Dockerfile

| Instruction | Does | Watch out |
| --- | --- | --- |
| `FROM` | Starts from a base image | Pin the version; `AS name` names a stage |
| `WORKDIR` | Sets (and creates) the working directory | Use it instead of `RUN cd …` |
| `COPY` | Copies files from the build context | Prefer it to `ADD` |
| `ADD` | Like `COPY`, but also fetches URLs and unpacks tar files | Surprising; only for those cases |
| `RUN` | Runs a command at build time, saves the result as a layer | Clean up in the same `RUN`, or the files stay in the layer |
| `ENV` | Sets an environment variable for build and run | Visible to anyone with the image: never secrets |
| `ARG` | A build-time variable | Also visible in the image history: never secrets |
| `EXPOSE` | Documents the port the app listens on | Doesn't publish anything; `-p` does |
| `USER` | Runs later instructions and the app as this user | Set a non-root user before `CMD` |
| `HEALTHCHECK` | A command Docker runs to mark the container healthy or unhealthy | Plain Docker only marks it, it doesn't restart; Kubernetes ignores it and uses its own probes |
| `ENTRYPOINT` | The fixed executable | Arguments from `docker run` are appended |
| `CMD` | The default command (or default arguments to `ENTRYPOINT`) | `docker run image other-command` replaces it |

### Exec form, not shell form

```dockerfile
CMD ["node", "server.js"]   # exec form: node is PID 1 and receives SIGTERM
CMD node server.js          # shell form: /bin/sh -c is PID 1 and doesn't pass SIGTERM on
```

With the shell form, `docker stop` sends SIGTERM to the shell, the shell ignores it, and after 10 seconds Docker sends SIGKILL. Every deploy waits 10 s and cuts off requests mid-flight.

### Order layers from least to most often changed

Once one layer's cache is invalid, **every layer after it is rebuilt**.

```dockerfile
# Bad: any code change reinstalls every package
COPY . .
RUN npm ci

# Good: packages are reinstalled only when package.json or the lockfile change
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
```

### .dockerignore

The **build context** (the folder you build from) is sent to the builder, and `COPY . .` copies all of it. Without a `.dockerignore`, your laptop's `node_modules` (built for macOS, not Linux), `.git` and `.env` go into the image.

```text
node_modules
.git
.env
dist
*.log
```

### A production Dockerfile for a Node app (multi-stage)

```dockerfile
# syntax=docker/dockerfile:1

# ---- build: dev dependencies, TypeScript, the compiler ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: only what runs in production ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# The node images ship a non-root user called node.
USER node
EXPOSE 3000
# slim has no curl; Node 18+ has fetch built in
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
```

**Multi-stage builds**: only the last stage becomes the image. The compiler, dev dependencies and source files stay behind in the build stage, so the image is smaller and has fewer packages for scanners to flag.

### Secrets while building

```dockerfile
# The token is mounted for this one RUN and never written into a layer
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t shop/api:1.4 .
```

### Choosing a base image

| Base | What's in it | Use when |
| --- | --- | --- |
| `node:22` | Full Debian with build tools: the biggest | Build stages that compile native modules |
| `node:22-slim` | Minimal Debian | The usual runtime default |
| `node:22-alpine` | Alpine Linux, musl instead of glibc: the smallest of the three | You've tested it: some native modules behave differently on musl |
| `gcr.io/distroless/nodejs22-debian12` | Node and its libraries only: no shell, no package manager | Hardened production images (harder to debug: no `sh` to exec into) |

---

## Running containers

| Flag | Does | Example |
| --- | --- | --- |
| `-d` | Runs in the background | `docker run -d nginx` |
| `-it` | Interactive terminal | `docker run -it --rm node:22 bash` |
| `--name` | A name to use instead of the id | `--name api` |
| `--rm` | Deletes the container when it stops | One-off commands |
| `-p host:container` | Publishes a port | `-p 8080:3000` |
| `-e`, `--env-file` | Environment variables | `-e NODE_ENV=production`, `--env-file .env` |
| `-v` | A volume or bind mount | `-v pgdata:/var/lib/postgresql/data` |
| `--restart` | Restart policy: `no`, `on-failure`, `always`, `unless-stopped` | `--restart unless-stopped` |
| `--memory`, `--cpus` | Resource limits (cgroups) | `--memory 512m --cpus 1` |
| `--init` | A tiny init as PID 1 that forwards signals and reaps zombie processes | Apps that don't handle SIGTERM |
| `--read-only` | Makes the container's filesystem read-only | Hardening; add `--tmpfs /tmp` |
| `--network` | Which network to join | `--network shop` |

```bash
docker run -d --name api -p 8080:3000 --env-file .env --restart unless-stopped shop/api:1.4
docker ps                       # running containers (-a: stopped ones too)
docker logs -f --tail 100 api   # follow the last 100 lines
docker exec -it api sh          # a shell inside the running container
docker stats                    # live CPU and memory per container
docker stop api                 # SIGTERM, then SIGKILL after 10 s
docker rm api                   # delete it, and its writable layer
```

### Exit codes worth knowing

| Code | Means | Check |
| --- | --- | --- |
| 0 | The app finished normally | |
| 1 | The app crashed or exited with an error | `docker logs api` |
| 137 | 128 + 9: killed with SIGKILL, by the OOM killer or after the stop timeout | `docker inspect api --format '{{.State.OOMKilled}}'` |
| 143 | 128 + 15: ended by SIGTERM | Usually a normal `docker stop` |

### Shutting down gracefully

The kernel doesn't apply the default "terminate" action to PID 1 in a container: a SIGTERM with no handler is simply ignored. Node installs no SIGTERM handler by default, so handle it yourself (or run with `--init`):

```javascript
const server = app.listen(3000);

process.on('SIGTERM', () => {
  // Stop accepting new connections and let open requests finish
  server.close(() => process.exit(0));
  // Give up before Docker's SIGKILL at 10 s
  setTimeout(() => process.exit(1), 9_000).unref();
});
```

---

## Data: volumes, bind mounts and tmpfs

| Type | Lives in | Use for | Example |
| --- | --- | --- | --- |
| Named volume | Docker's own area on the host (`/var/lib/docker/volumes`) | Databases and anything that must survive `docker rm` | `-v pgdata:/var/lib/postgresql/data` |
| Bind mount | A host folder you choose | Development: edit code on your laptop, run it in the container | `-v "$PWD":/app` |
| tmpfs | Memory only | Scratch files, things that must never touch disk | `--tmpfs /tmp` |

- The container's own writable layer **disappears with the container** and is slow for heavy writes (copy-on-write). Never keep a database there.
- Removing a container doesn't remove its named volumes. `docker volume ls` shows them, and `docker volume rm` or `docker compose down -v` deletes them.
- Back up a volume with a throwaway container:

```bash
docker run --rm -v pgdata:/data -v "$PWD":/backup alpine tar czf /backup/pgdata.tgz -C /data .
```

---

## Networking

- The **default bridge** (`docker0`) gives each container a private IP such as `172.17.0.2`. Containers on it can reach each other only by IP.
- A **user-defined network** (`docker network create shop`, and every Compose project) adds built-in DNS: containers reach each other **by name**, such as `db:5432`.
- `-p 8080:3000` publishes the container's port 3000 on the host's port 8080. Without `-p`, nothing outside Docker's networks can reach the container.
- Inside a container, **`localhost` is the container itself**, not your laptop and not the other containers. On Docker Desktop, `host.docker.internal` reaches your laptop.
- `--network host` (Linux) shares the host's network stack: no port mapping, no network isolation.

```bash
docker network create shop
docker run -d --name db --network shop -e POSTGRES_PASSWORD=dev postgres:17
docker run -d --name api --network shop -p 8080:3000 \
  -e DATABASE_URL=postgres://postgres:dev@db:5432/postgres shop/api:1.4
# api finds the database at db:5432; only api is reachable from the host
```

> ⚠️ `-p 5432:5432` listens on **every** network interface of the host, and on Linux Docker's NAT rules are applied before `ufw` gets to filter them. On a cloud server, your "local" database is open to the internet. Write `-p 127.0.0.1:5432:5432` instead.

---

## Docker Compose

One file describes the whole stack: services, networks and volumes. Compose creates a network for the project, so services find each other by service name.

```yaml
# compose.yaml
services:
  api:
    build: .
    ports:
      - "8080:3000"
    environment:
      DATABASE_URL: postgres://app:app@db:5432/shop
      REDIS_URL: redis://cache:6379
    depends_on:
      db:
        condition: service_healthy   # wait until Postgres answers, not just until it starts
      cache:
        condition: service_started
    restart: unless-stopped

  db:
    image: postgres:17
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: shop
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"        # reachable from your laptop only
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d shop"]
      interval: 5s
      timeout: 3s
      retries: 10

  cache:
    image: redis:7-alpine

volumes:
  pgdata:
```

```bash
docker compose up -d --build    # build the api image, start all three in the background
docker compose ps               # what's running, and health
docker compose logs -f api      # follow one service's logs
docker compose exec db psql -U app shop
docker compose down             # stop and remove containers and the network (volumes kept)
docker compose down -v          # ...and delete the volumes: the database is gone
```

- `depends_on` on its own only sets the **start order**. It doesn't wait until the database accepts connections. Add a `healthcheck` and `condition: service_healthy`, and still retry the connection in your app.
- Leave out the old top-level `version:` key: current Compose ignores it.
- Compose runs containers on **one machine**: development, CI, small servers. Across many machines you need an orchestrator such as ECS or Kubernetes.

---

## From laptop to production

```text
git push → CI builds the image → tags it with the commit → pushes to a registry (ECR)
        → the orchestrator pulls it and runs N copies behind a load balancer
        → new version: start new containers, check health, then stop the old ones
```

```bash
# Build and push to Amazon ECR, tagged with the git commit
docker build -t 123456789012.dkr.ecr.ap-south-1.amazonaws.com/shop-api:3f9c2ab .
aws ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.ap-south-1.amazonaws.com
docker push 123456789012.dkr.ecr.ap-south-1.amazonaws.com/shop-api:3f9c2ab
```

House rules for images that run well anywhere:

- **One process per container.** The API, the worker and the database are separate containers.
- **Config from the environment**, not baked in. The same image goes to staging and production.
- **Logs to stdout and stderr.** The platform collects them; don't write log files inside the container.
- **Stateless.** State lives in a database, a volume or object storage, so any copy can be killed and replaced.
- **Immutable.** Never `docker exec` in to patch a running container. Fix the Dockerfile, build, deploy.

---

## How to choose: container, VM or serverless?

```text
Ship an app with its dependencies, the same everywhere?          → container
Need another OS or kernel, or strong isolation between tenants?   → VM (or a microVM: Firecracker, gVisor, Kata)
Short, event-driven functions and no servers to think about?      → serverless (Lambda), microVMs underneath
Several containers on one machine (dev, CI)?                      → Docker Compose
Many containers across many machines, with scaling and healing?   → an orchestrator: ECS, Kubernetes
```

---

## ⚠️ Critical Mistakes

- No `.dockerignore`: your Mac's `node_modules` and your `.env` end up in the image.
- `COPY . .` before `npm ci`: every code change reinstalls every package.
- Secrets in `ENV`, `ARG` or a copied `.env`: anyone who can pull the image can read them with `docker history` or `docker inspect`. Pass them at run time, or use build secrets.
- Running as root: if someone breaks out of the container, they're root on the host. Add `USER`.
- Shell-form `CMD`, or no SIGTERM handler: every stop waits 10 s and then kills in-flight requests.
- `:latest` in production: you can't tell what's running or roll back. Tag with the commit; deploy by digest.
- A database in the container's writable layer: gone at `docker rm`. Use a named volume.
- `localhost` to reach another container: use its service name.
- `-p 5432:5432` on a cloud server: the database is on the internet, past `ufw`. Bind to `127.0.0.1`.
- `docker compose down -v` on the dev database you cared about.
- Mounting `/var/run/docker.sock` into a container, or `--privileged`: that container now controls the host.
- A memory limit with no matching heap size: Node grows past it and is OOM-killed (137) under load. Set `--max-old-space-size` to about three quarters of the limit.
- Treating `depends_on` as "wait until ready".

---

## Interview Q&As

**Q: What's the difference between a container and a virtual machine?**

A: A VM virtualises hardware: a hypervisor gives each VM virtual CPU, memory and disk, and each VM boots its own OS and kernel. A container virtualises the OS's view: it's a process on the host's kernel, isolated with namespaces and limited with cgroups. Containers are megabytes and start in under a second; VMs are gigabytes and boot in tens of seconds. VMs isolate better, because a container escape only needs a kernel bug. In the cloud you usually get both: containers inside VMs.

**Q: What is an image layer, and why does the order of a Dockerfile matter?**

A: Each `RUN`, `COPY` or `ADD` saves its filesystem changes as a layer, cached by the instruction and its inputs. When one layer changes, every layer after it is rebuilt. So put what changes least first: base image, system packages, then the dependency manifest and install, and your source code last. Then a code change rebuilds only the last layer instead of reinstalling every package.

**Q: CMD vs ENTRYPOINT? Exec form vs shell form?**

A: `ENTRYPOINT` is the executable that always runs; `CMD` is the default command, or default arguments to the entrypoint, and `docker run image …` replaces it. Exec form (`["node", "server.js"]`) runs the program directly as PID 1, so it gets SIGTERM. Shell form (`node server.js`) runs it under `/bin/sh -c`, which doesn't pass signals on, so `docker stop` waits 10 s and kills it.

**Q: How is a container isolated from the host and from other containers?**

A: Namespaces limit what it sees (its own process tree, network stack, filesystem, hostname, users). cgroups limit what it uses (memory, CPU, process count). On top, Docker drops most Linux capabilities and applies a seccomp profile that blocks risky system calls. It's still the same kernel, which is why containers alone aren't enough for running untrusted code.

**Q: Your container keeps exiting with code 137. What's happening?**

A: 137 is 128 + 9: the process got SIGKILL. Either the kernel's OOM killer ended it for going over the memory limit (`docker inspect` shows `OOMKilled: true`), or it ignored SIGTERM and Docker killed it after the stop timeout. For memory, raise the limit or cap the heap below it (`--max-old-space-size` for Node) and look for a leak. For stops, handle SIGTERM or run with `--init`.

**Q: How do you make an image smaller and safer?**

A: Multi-stage builds, so compilers and dev dependencies stay out of the final image. A slim or distroless base. A `.dockerignore`. Fewer, cleaner layers (clean caches in the same `RUN`). Run as a non-root user, pin base image versions, never bake in secrets, and scan the image for known vulnerabilities (Docker Scout, Trivy) in CI.

**Q: Where should a database in a container keep its data?**

A: In a named volume mounted at its data directory, for example `/var/lib/postgresql/data` for Postgres 17. The container's writable layer is deleted with the container and is slow for heavy writes. In production, many teams skip running the database in a container at all and use a managed service like RDS.

**Q: Two containers need to talk to each other. How?**

A: Put them on the same user-defined network (Compose does this for you) and use the container or service name as the hostname: Docker's built-in DNS resolves `db` to the database container's IP. Not `localhost`, which inside a container means the container itself. Only publish ports (`-p`) for what must be reached from outside.

**Q: Why does docker stop take 10 seconds for my Node app?**

A: `docker stop` sends SIGTERM and waits 10 s before SIGKILL. Your app is PID 1 in its container, and PID 1 ignores a SIGTERM it has no handler for. Node adds no SIGTERM handler by default, and a shell-form `CMD` makes `sh` PID 1, which doesn't pass the signal on. Use exec form, handle SIGTERM (close the server, then exit), or add `--init`.

**Q: Docker vs Kubernetes?**

A: Docker builds images and runs containers on one machine. Kubernetes (or ECS) runs containers across a cluster of machines: it decides where each one goes, keeps the requested number running, restarts failed ones, rolls out new versions gradually, gives services stable names and scales them. They work together: you build with Docker, and the orchestrator runs what you built.

**Q: Is a container safe enough for running untrusted code?**

A: Not by itself, because every container shares the host kernel. For untrusted or multi-tenant code, add a stronger boundary: a VM per tenant, or a sandbox such as gVisor, Kata Containers or Firecracker microVMs. Firecracker is what AWS built to run Lambda functions from different customers side by side.

---

## Related topics

- [ECS on Fargate](/?topic=aws-ecs-fargate&read): running these images on AWS without managing servers
- [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read): build, push to ECR, and blue/green deploys
- [AWS Basics](/?topic=aws-basics&read): EC2 instances, the VMs your containers run on
- [Redis Basics](/?topic=redis-basics&read): the cache in the Compose file above

---

## Sources

- [Docker: Building best practices](https://docs.docker.com/build/building/best-practices/)
- [Docker: Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker: Volumes](https://docs.docker.com/engine/storage/volumes/)
- [Docker: Networking overview](https://docs.docker.com/engine/network/)
- [Docker: Control startup order in Compose](https://docs.docker.com/compose/how-tos/startup-order/)
- [Linux namespaces (man 7 namespaces)](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [docker-curriculum](https://docker-curriculum.com/): a free hands-on tutorial (MIT)
- [Firecracker](https://firecracker-microvm.github.io/)

---

## Why This Matters

✅ Every deploy you'll do on AWS, Kubernetes or a CI pipeline starts with an image, so this is the base everything else stands on.

✅ Knowing that a container is a process on a shared kernel (namespaces, cgroups) explains its speed, its limits and its security trade-off in one go.

✅ Layer order, multi-stage builds, SIGTERM and exit code 137 are what separate "I've run docker" from "I've shipped containers", and interviewers ask exactly these.
