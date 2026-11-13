# ECS on Fargate: Task Definitions, Services, Roles, Auto Scaling and Safe Deploys

> 💡 **TL;DR**: **ECS** (Elastic Container Service) runs your Docker images on AWS. You describe a container in a **task definition** (image, CPU and memory, ports, environment, secrets, logs, roles), and a **service** keeps N copies (**tasks**) running behind a load balancer, replacing any that die. With **Fargate**, AWS supplies the machines: you pick a task size and pay per vCPU and GB per second, with no servers to patch. Each task gets its **own network interface** in your private subnets. Your code gets AWS permissions from the **task role**; ECS itself pulls the image and writes logs with the **execution role**. Scale on CPU or requests per target, deploy with a **rolling update plus circuit breaker** (or blue/green), and size subnets for twice your tasks.

Builds on [Docker](/?topic=docker-vs-vm&read), [VPC Networking](/?topic=aws-vpc&read) and [Application Load Balancer](/?topic=aws-alb&read). Next: [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read) adds the pipeline that deploys it.

---

## ECS at a glance

| Term | What it is | Example |
| --- | --- | --- |
| ECR | AWS's private Docker registry | `111122223333.dkr.ecr.ap-south-1.amazonaws.com/orders-api:3f9c2ab` |
| Cluster | A named group that services and tasks run in | `prod` |
| Task definition | A versioned recipe: containers, size, roles, network mode | `orders-api:42` (family:revision) |
| Task | One running copy of a task definition | `arn:aws:ecs:…:task/prod/4c1e…` |
| Service | Keeps N tasks running, registers them with the load balancer, deploys new versions | `orders-api`, desired count 2 |
| Launch type / capacity provider | Where tasks run: Fargate, Fargate Spot, or your own EC2 instances | `FARGATE` |
| Task role | AWS permissions for **your code** | Write to the `Orders` table |
| Execution role | AWS permissions for **ECS**, to start the task | Pull from ECR, write logs, read secrets |
| `awsvpc` networking | Each task gets its own ENI and private IP | Security groups per task |
| Service Connect / Cloud Map | Service-to-service discovery by name | `http://payments:3000` |

---

## Fargate, EC2 launch type, EKS or Lambda?

| | ECS on Fargate | ECS on EC2 | EKS | Lambda |
| --- | --- | --- | --- | --- |
| You manage | Task definitions only | Plus the instances: AMIs, patching, scaling | Kubernetes itself, plus nodes (or Fargate) | Functions only |
| Billed | Per task vCPU and GB, per second | Per instance, whatever runs on it | Control plane per hour plus nodes | Per request and GB-second |
| Good for | Most web services and workers | GPUs, very large tasks, dense packing with Savings Plans | Teams already on Kubernetes, its ecosystem, portability | Spiky, event-driven, short work |
| Limits | No GPUs, no privileged containers; max 16 vCPU / 120 GB per task | You run the fleet | More moving parts | 15-minute limit, cold starts |

For a small team shipping web services, **ECS on Fargate** is the shortest path from a Docker image to production on AWS.

---

## From image to running task

1. **Build and push** the image to ECR, tagged with the git commit.
2. **Register** a new task definition revision that points at that tag.
3. **Update the service** to the new revision.
4. The ECS scheduler picks subnets across your AZs and asks Fargate for capacity.
5. Fargate attaches an **ENI** (a network interface with a private IP) from your subnet to the task.
6. ECS uses the **execution role** to pull the image from ECR and fetch secrets, then starts the containers.
7. When the container is running, the service **registers the task's IP** in the target group; the ALB health check must pass before it gets traffic.
8. Logs from stdout and stderr go to **CloudWatch Logs** through the `awslogs` driver.

In the topic's simulator, steps 4 to 7 take about **2 minutes**, and that start-up time is what limits how fast the service can react to a spike.

---

## A task definition, line by line

```json
{
  "family": "orders-api",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "512",
  "memory": "1024",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::111122223333:role/orders-api-execution",
  "taskRoleArn": "arn:aws:iam::111122223333:role/orders-api-task",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "111122223333.dkr.ecr.ap-south-1.amazonaws.com/orders-api:3f9c2ab",
      "essential": true,
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "ORDERS_TABLE", "value": "Orders" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:ap-south-1:111122223333:secret:prod/orders/db-url-AbCdEf" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/orders-api",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "api"
        }
      },
      "stopTimeout": 30
    }
  ]
}
```

| Field | Why it matters |
| --- | --- |
| `cpu`, `memory` | Task size, in CPU units (1,024 = 1 vCPU) and MiB; must be a valid Fargate pair |
| `runtimePlatform` | `ARM64` runs on Graviton, about 20% cheaper; the image must be built for arm64 |
| `executionRoleArn` | Lets ECS pull from ECR, write logs and read the `secrets` |
| `taskRoleArn` | What your code may call: DynamoDB, S3, SQS… |
| `image` | Pin a commit tag or digest, never `latest` |
| `secrets` | Injected as environment variables **when the task starts**; a rotated secret needs new tasks |
| `essential` | If this container stops, the whole task stops |
| `stopTimeout` | Seconds between SIGTERM and SIGKILL (Fargate allows up to 120) |

---

## Task sizes and what they cost

| vCPU | Memory choices |
| --- | --- |
| 0.25 | 0.5, 1 or 2 GB |
| 0.5 | 1 to 4 GB, in 1 GB steps |
| 1 | 2 to 8 GB, in 1 GB steps |
| 2 | 4 to 16 GB, in 1 GB steps |
| 4 | 8 to 30 GB, in 1 GB steps |
| 8 | 16 to 60 GB, in 4 GB steps |
| 16 | 32 to 120 GB, in 8 GB steps |

Prices in the topic (us-east-1, Linux x86): **$0.04048 per vCPU-hour** and **$0.004445 per GB-hour**.

- A 0.5 vCPU / 1 GB task: 0.5 × $0.04048 + 1 × $0.004445 = **$0.024685 an hour**, about **$18 a month**.
- Two of them all month: about **$36**. Scaling to 12 for a 3-hour sale adds 10 × 3 × $0.024685 ≈ **$0.74**.
- **Graviton (ARM64)** is about 20% cheaper; **Fargate Spot** is up to 70% cheaper but can be stopped with a 2-minute warning: fine for workers and dev, not as your only API capacity.

Smaller tasks scale in finer steps; bigger tasks waste less on per-task overhead. Measure, then right-size: the topic's story finds tasks running at 15% CPU and halves their size.

---

## Networking and the two roles

- `awsvpc` mode: every task has its **own private IP and security group**. The API tasks' security group accepts the app port only from the ALB's security group.
- Tasks run in **private subnets** with no public IP. To pull images and send logs they need a way out: a **NAT gateway**, or VPC endpoints for `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`, plus the **S3 gateway endpoint** (image layers are stored in S3).
- One IP per task: **size subnets for twice the maximum task count**, because a rolling deploy runs old and new side by side.

| | Execution role | Task role |
| --- | --- | --- |
| Used by | The ECS agent, before and around your container | Your code inside the container |
| Typical permissions | `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `logs:PutLogEvents`, `secretsmanager:GetSecretValue` on the task's secrets | `dynamodb:PutItem` on `Orders`, `s3:GetObject` on one bucket |
| If it's wrong | The task never starts (`CannotPullContainerError`, `ResourceInitializationError`) | The app gets `AccessDenied` at runtime |

---

## Auto scaling

ECS services scale through **Application Auto Scaling**: a minimum, a maximum, and a policy.

From the topic's numbers: one vCPU of the app serves about 400 req/s at full CPU, so a 0.5 vCPU task serves 200.

| Traffic | At the 50% CPU target | At 100% CPU |
| --- | --- | --- |
| Normal, 200 req/s | 2 tasks (each at 50%) | 1 task |
| Sale, 1,200 req/s | 1,200 ÷ (200 × 0.5) = **12 tasks** | 6 tasks |

- **Target tracking** on `ECSServiceAverageCPUUtilization` (CPU-bound apps) or `ALBRequestCountPerTarget` (I/O-bound apps); **queue depth** for workers.
- It scales **out quickly** (after about three minutes over the target) and **in slowly** (after about 15 minutes below it), so it doesn't flap.
- **Start-up time** is the real limit: smaller images, less start-up work and quicker health checks let it react faster.
- **Scheduled scaling** raises the minimum before known peaks; target tracking handles surprises.
- Set a **maximum** your database and downstream services can actually take.

```hcl
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.prod.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 2
  max_capacity       = 12
}

resource "aws_appautoscaling_policy" "cpu_50" {
  name               = "cpu-50"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = 50
    scale_in_cooldown  = 60
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
```

---

## Deploying safely

### Rolling update (the default)

```hcl
resource "aws_ecs_service" "api" {
  name            = "orders-api"
  cluster         = aws_ecs_cluster.prod.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [aws_security_group.api.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_minimum_healthy_percent = 100   # never drop below the desired count
  deployment_maximum_percent         = 200   # start a full new set before stopping the old one

  deployment_circuit_breaker {
    enable   = true
    rollback = true   # a release whose tasks keep failing goes back by itself
  }

  lifecycle {
    ignore_changes = [desired_count]   # auto scaling owns it
  }
}
```

- With **100% / 200%**, ECS starts new tasks, waits for them to be healthy, then stops the old ones: no drop in capacity, but twice the tasks (and IPs) for a few minutes.
- The **circuit breaker** counts tasks that fail to start or fail health checks. After `max(3, ceil(0.5 × desired))` failures (3 for 2 tasks, 5 for 10) it marks the deployment failed and, with `rollback`, returns to the last good revision. Without it, the topic's story shows a deploy retrying a broken image for hours.
- The circuit breaker only catches tasks that **won't start or won't pass health checks**. A release that starts fine but returns wrong answers needs **alarms**: see blue/green in [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read).

### Graceful shutdown

When a task is stopped, ECS deregisters it from the target group (the ALB stops sending new requests and waits up to the **deregistration delay**), sends **SIGTERM**, waits `stopTimeout`, then **SIGKILL**. Handle SIGTERM in the app (stop accepting, finish in-flight, exit), and set the target group's deregistration delay to a little more than your longest request rather than the default 300 s.

---

## Debugging a task that won't stay up

| Stopped reason | Usually means | Fix |
| --- | --- | --- |
| `CannotPullContainerError` | No route to ECR (no NAT or endpoints), wrong image tag, or the execution role can't read the repo | Check routes, the tag, and the execution role |
| `ResourceInitializationError: unable to pull secrets` | The execution role can't read the secret, or no route to Secrets Manager | Permissions on the secret (and its KMS key), endpoint or NAT |
| `Essential container in task exited` (exit 1) | The app crashed on start | Read its CloudWatch logs: often a missing environment variable |
| `OutOfMemoryError: Container killed due to memory usage` (exit 137) | Over the task's memory | More memory, or cap Node's heap below it |
| `Task failed ELB health checks` | The health check path, port or timing is wrong, or the app is slow to start | Health check grace period, the right path, a shallow `/status` |
| Tasks stuck in `PENDING` | No free IPs in the subnets, or account quota | Bigger subnets, quota increase |

```bash
# Why did the last tasks stop?
aws ecs describe-tasks --cluster prod \
  --tasks $(aws ecs list-tasks --cluster prod --service-name orders-api --desired-status STOPPED --query 'taskArns[0:3]' --output text) \
  --query 'tasks[].{reason:stoppedReason,exit:containers[0].exitCode}'

# What the service has been doing (deploys, failures, scaling)
aws ecs describe-services --cluster prod --services orders-api --query 'services[0].events[0:10].message'

# A shell inside a running task (service needs enableExecuteCommand, task role needs SSM permissions)
aws ecs execute-command --cluster prod --task 4c1e2b3a9f8e4d7c --container api --interactive --command "sh"
```

---

## How to choose

```text
Docker image, web API or worker, no wish to run servers?   → ECS on Fargate
Need GPUs, >16 vCPU per task, or cheapest per core at scale? → ECS on EC2 (capacity providers + Savings Plans)
Interruptible workers or dev environments?                   → Fargate Spot alongside on-demand
CPU-bound API?                                               → target tracking on CPU
I/O-bound API (waits on DB and other services)?              → target tracking on ALB requests per target
Queue workers?                                               → scale on queue depth / age
Only need "did it start?" protection?                        → rolling + circuit breaker
Need test traffic, gradual shift and instant rollback?       → blue/green (CodeDeploy or ECS native)
```

---

## ⚠️ Critical Mistakes

- `latest` in the task definition: you can't tell what's running, and a restart may pull something new.
- One role for both jobs, or app permissions on the **execution role**.
- Secrets as plain `environment` values in the task definition (visible in the console and API) instead of `secrets`.
- Private subnets with **no NAT and no endpoints**: every task fails with `CannotPullContainerError`.
- **/24 subnets** for a service that scales to hundreds of tasks: deploys stick in `PENDING`.
- No **circuit breaker**: a bad image is retried for hours.
- No SIGTERM handling, or a 300 s deregistration delay on a fast API: slow deploys and dropped requests.
- A health check that calls the database: one slow query marks every task unhealthy.
- Building an **x86 image** for an `ARM64` task (or the reverse): `exec format error`.
- **No maximum** on auto scaling, or one higher than the database can take.
- Terraform managing `desired_count` while auto scaling also changes it: every apply resets it.
- Fargate Spot as the **only** capacity for a customer-facing API.

---

## Interview Q&As

**Q: What's the difference between a task definition, a task and a service?**

A: A task definition is the versioned recipe (image, CPU and memory, ports, roles, env, logs). A task is one running copy of it. A service keeps a desired number of tasks running, replaces failed ones, registers them with a load balancer and rolls out new task definition revisions.

**Q: Fargate or EC2 launch type?**

A: Fargate when you don't want to manage servers: AWS provides isolated capacity per task and bills per task size per second. EC2 when you need GPUs, very large tasks, privileged containers, or the lowest cost per core by packing many tasks on reserved or Savings-Plan instances, at the price of patching and scaling the instances yourself.

**Q: Task role vs execution role?**

A: The execution role is used by ECS to start the task: pull the image from ECR, send logs to CloudWatch, fetch secrets. The task role is what the application code inside the container uses to call AWS APIs. Mixing them gives either too much power to ECS or too much to your code.

**Q: How does an ECS service scale, and what limits how fast?**

A: Application Auto Scaling changes the service's desired count based on a target tracking policy (CPU, memory, ALB requests per target) or schedules. It's limited by task start-up time (placing the task, pulling the image, starting the app, passing health checks: often one to a few minutes), so keep images small, start-up fast, and pre-scale for known peaks.

**Q: How do you deploy without downtime?**

A: Rolling update with minimum healthy 100% and maximum 200%: new tasks start and pass health checks before old ones stop. Add the deployment circuit breaker with rollback for releases that can't start. Handle SIGTERM and tune the deregistration delay. For gradual exposure with instant rollback, use blue/green with alarms.

**Q: Your tasks keep stopping right after they start. How do you debug?**

A: Look at the stopped reason and exit code (`describe-tasks`), the service events, and the container's CloudWatch logs. Common causes: can't pull the image (network or execution role), can't fetch secrets, the app crashes on missing config, out of memory (137), or failing load balancer health checks.

**Q: How does a task in a private subnet pull its image?**

A: Through a NAT gateway to ECR's public endpoints, or privately through VPC interface endpoints for `ecr.api` and `ecr.dkr` plus the S3 gateway endpoint for the layers (and `logs` and `secretsmanager` endpoints for logging and secrets). The execution role must allow the ECR actions.

**Q: How many IP addresses does a Fargate service need?**

A: One per task in `awsvpc` mode. During a rolling deploy with maximum 200% you can briefly run twice the desired count, so plan for at least double the maximum, across the subnets in each AZ.

---

## Related topics

- [Docker](/?topic=docker-vs-vm&read): the images ECS runs
- [VPC Networking](/?topic=aws-vpc&read): private subnets, NAT, endpoints
- [Application Load Balancer](/?topic=aws-alb&read): the target group tasks register into
- [AWS IAM](/?topic=aws-iam&read): task roles and execution roles
- [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read): the pipeline and blue/green deploys
- [Terraform Modules](/?topic=terraform-modules&read): building the service once per environment

---

## Sources

- [Amazon ECS task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html)
- [Task definition parameters (including Fargate task sizes)](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [Task IAM role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html) and [task execution IAM role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html)
- [Deployment circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html)
- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [terraform-aws-modules/ecs](https://github.com/terraform-aws-modules/terraform-aws-ecs) (Apache 2.0) and [amazon-ecs-fullstack-app-terraform](https://github.com/aws-samples/amazon-ecs-fullstack-app-terraform) (MIT-0), which the topic's settings follow

---

## Why This Matters

✅ "How would you run this service on AWS?" has a two-sentence answer now: an ECS service on Fargate behind an ALB, in private subnets, scaling on CPU, deployed with a circuit breaker.

✅ Execution role vs task role, IPs per task and start-up time as the scaling limit are the details interviewers use to tell who has actually run containers in production.

✅ The stopped-reasons table turns a late-night "tasks keep restarting" into a five-minute fix.
