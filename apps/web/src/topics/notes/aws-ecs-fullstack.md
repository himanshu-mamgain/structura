# Full-stack App on ECS: From git push to Production with Blue/Green and Automatic Rollback

> 💡 **TL;DR**: A real AWS app is the pieces you already know (a VPC, load balancers, ECS services on Fargate, DynamoDB or RDS, S3) plus a **pipeline** that ships every change the same way. A push starts **CodePipeline**; **CodeBuild** builds the Docker image, tags it with the commit and pushes it to **ECR**; **CodeDeploy** starts the new version (**green**) beside the old one (**blue**), shifts traffic **all at once, as a canary or linearly**, and **rolls back** to blue if a deployment fails or a **CloudWatch alarm** fires. The circuit breaker catches releases that can't start; only **alarms on user-facing signals** catch releases that start fine but are wrong. Keep blue for a few minutes after the shift, and rollback is instant.

Follows the open-source sample **Amazon ECS fullstack app with Terraform** (MIT-0). Builds on [VPC Networking](/?topic=aws-vpc&read), [Application Load Balancer](/?topic=aws-alb&read) and [ECS on Fargate](/?topic=aws-ecs-fargate&read).

---

## The architecture at a glance

```text
Visitors ──► Client ALB ──► Client tasks (Vue, Fargate)        ← public subnets → private subnets, 2 AZs
         └─► Server ALB ──► Server tasks (Node.js, Fargate) ──► DynamoDB table
                                                         └────► S3 bucket (product images)
Developer ── git push ──► GitHub ──► CodePipeline
                                       ├─► CodeBuild: docker build, push to ECR, write taskdef + appspec
                                       ├─► CodeDeploy: blue/green on the Server ALB (and Client ALB)
                                       └─► SNS: success / failure notifications
```

| Piece | Role in the sample | Production note |
| --- | --- | --- |
| VPC, 2 AZs, **one** NAT gateway | Networking | Use one NAT per AZ in production |
| Two internet-facing ALBs | One for the client, one for the server | One ALB with host or path rules costs less |
| Two ECS services on Fargate | Client and server, 0.25 vCPU / 0.5 GB each | Right-size after measuring |
| Auto scaling | Target tracking at 50% CPU and memory, 1 to 4 tasks | Minimum 2 across AZs for availability |
| ECR | One repository per service | Lifecycle policy to expire old images |
| DynamoDB, S3 | Data and product images | Point-in-time recovery on the table |
| CodePipeline, CodeBuild, CodeDeploy | Build and blue/green deploy | Alarms for automatic rollback |
| SNS | Notifications | Wire to Slack or email |
| Terraform | Everything above | Remote state in S3 with locking for a team |

---

## The path of one change

1. A developer pushes to `main`; a **CodeStar connection** (or webhook) starts **CodePipeline**.
2. **CodeBuild** runs `buildspec.yml`: logs in to ECR, builds the image, tags it with the commit, pushes it, and writes `imageDetail.json`, `taskdef.json` and `appspec.yaml` as artifacts.
3. CodePipeline's **ECS (Blue/Green)** action registers a new task definition revision with the new image and hands it to **CodeDeploy**.
4. CodeDeploy starts **green** tasks on the **replacement target group**, waits for them to pass health checks, and (optionally) routes a **test listener** to them first.
5. It **shifts production traffic** from blue to green according to the deployment configuration.
6. If a **deployment step fails** or a listed **CloudWatch alarm** goes into ALARM, it moves the listener back to blue: instant, because blue is still running.
7. After the **termination wait** (5 minutes in the sample), blue tasks are stopped, and SNS reports the result.

---

## buildspec.yml and appspec.yaml

```yaml
# buildspec.yml (CodeBuild)
version: 0.2
phases:
  pre_build:
    commands:
      - REPO_HOST=$(echo "$REPO_URI" | cut -d/ -f1)
      - aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REPO_HOST"
      - TAG=$(echo "$CODEBUILD_RESOLVED_SOURCE_VERSION" | cut -c1-7)   # the commit: one tag, one build
  build:
    commands:
      - docker build -t "$REPO_URI:$TAG" ./server
  post_build:
    commands:
      - docker push "$REPO_URI:$TAG"
      - printf '{"ImageURI":"%s"}' "$REPO_URI:$TAG" > imageDetail.json
artifacts:
  files:
    - imageDetail.json
    - taskdef.json      # task definition template with "image": "<IMAGE1_NAME>"
    - appspec.yaml
```

```yaml
# appspec.yaml (CodeDeploy, ECS)
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: <TASK_DEFINITION>     # filled in by the pipeline
        LoadBalancerInfo:
          ContainerName: "server"
          ContainerPort: 3001
```

The pipeline swaps `<IMAGE1_NAME>` in `taskdef.json` for the image in `imageDetail.json`, registers that task definition, and puts its ARN in place of `<TASK_DEFINITION>`.

---

## Blue/green on ECS, underneath

```text
Production listener :443 ──► target group BLUE  (tasks running v41)
Test listener      :8443 ──► target group GREEN (tasks running v42)   ← you can hit green before users do

Shift (canary 10%, 5 min):
  minute 0   :443 → 90% BLUE / 10% GREEN
  minute 5   :443 → 0% BLUE / 100% GREEN        (if no alarm fired)
  minute 10  BLUE tasks terminated              (after the termination wait)
Rollback at any point before termination: :443 → 100% BLUE, immediately
```

The service needs **two target groups** and the ECS service's deployment controller set to `CODE_DEPLOY`. While both sets run, you have **twice the tasks**: check subnet addresses and Fargate quotas. (ECS also has built-in blue/green deployments now, configured on the service itself; the idea is the same.)

---

## Choosing a traffic-shifting configuration

| CodeDeploy configuration | Shifts | Exposure to a bad release before the alarm can act |
| --- | --- | --- |
| `CodeDeployDefault.ECSAllAtOnce` | 100% at once | Every user |
| `CodeDeployDefault.ECSCanary10Percent5Minutes` | 10%, then the rest after 5 minutes | 10% of users for the alarm's reaction time |
| `CodeDeployDefault.ECSCanary10Percent15Minutes` | 10%, then the rest after 15 minutes | Same, with longer to notice slow problems |
| `CodeDeployDefault.ECSLinear10PercentEvery1Minutes` | 10% more each minute | Grows each minute until the alarm fires |
| `CodeDeployDefault.ECSLinear10PercentEvery3Minutes` | 10% more every 3 minutes | Grows more slowly; a 30-minute deploy |

### What a bad release costs (the topic's simulator)

Traffic: **3,000 API requests a minute**. The broken release fails **30%** of them, so **900 failures a minute** at full traffic.

| Setup | What happens | Failed requests |
| --- | --- | --- |
| All at once, **no alarm** | Someone notices after 15 minutes; blue is already gone (5-minute wait), so a fresh redeploy takes 10 more minutes: errors for 26 minutes | 26 × 900 = **23,400** |
| Canary 10%, **alarm** at more than 50 errors a minute for 2 minutes | 10% of traffic sees errors: 90 a minute; the alarm fires after 2 minutes and CodeDeploy points the listener back at blue | 2 × 90 = **180** |

The alarm and the canary together cut the damage by more than 99%, and nobody had to be awake.

---

## Rollback triggers: what catches what

| Trigger | Catches | Misses |
| --- | --- | --- |
| Tasks fail to start, crash, or fail health checks | Broken images, missing config, crashes on boot | A release that starts fine and returns wrong results |
| **CloudWatch alarm** on the green target group's 5xx count or rate | Errors under real traffic | Wrong-but-200 responses |
| Alarm on **latency** (p99 target response time) | Slow queries, N+1s, missing indexes | Correctness bugs |
| Alarm on a **business metric** (orders a minute, payment success rate) | Silent breakage: checkout button does nothing | Needs steady traffic to be meaningful |
| Manual stop | Anything a human sees | Only works while someone is watching |

Alarms should be **rates over a minute or two** with **two or three datapoints**: too sensitive and good releases roll back on a blip; too lax and bad ones slip through.

```bash
# 5xx from the green target group: more than 50 in a minute, two minutes in a row
aws cloudwatch put-metric-alarm --alarm-name orders-api-green-5xx \
  --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=app/server-alb/50dc6c495c0c9188 Name=TargetGroup,Value=targetgroup/server-green/943f017f100becff \
  --statistic Sum --period 60 --evaluation-periods 2 --threshold 50 \
  --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching
```

---

## The same pipeline with GitHub Actions

Many teams skip CodePipeline and deploy from GitHub Actions with a role assumed through **OIDC** (no stored keys):

```yaml
name: deploy
on:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111122223333:role/deploy-role
          aws-region: ap-south-1
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - run: |
          IMAGE=${{ steps.ecr.outputs.registry }}/orders-api:${GITHUB_SHA::7}
          docker build -t "$IMAGE" ./server && docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"
      - id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: server/taskdef.json
          container-name: server
          image: ${{ env.IMAGE }}
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          service: orders-api
          cluster: prod
          wait-for-service-stability: true
```

With a rolling deployment and the circuit breaker, this is enough for most services. Add CodeDeploy (or ECS's built-in blue/green) when you want canaries with alarm-driven rollback.

---

## Terraform for a team

The sample keeps Terraform state on one laptop. For a team:

- **Remote state** in S3 with locking, so two `apply`s can't run at once: see [Terraform Remote State](/?topic=terraform-state&read).
- **One root module per environment** (dev, staging, prod) sharing versioned modules: see [Terraform Modules](/?topic=terraform-modules&read).
- **Plan in CI** on every pull request, apply only after review, from the pipeline's role.
- The pipeline's **GitHub token** or connection lives in Secrets Manager or a CodeStar connection, never in a `.tfvars` file.
- Let the pipeline own the **image tag** and task definition revisions; tell Terraform to ignore them (`ignore_changes`) so an apply doesn't roll production back to an old image.

---

## How to choose a deployment strategy

```text
Small team, one service, want it simple?                 → rolling + circuit breaker (GitHub Actions or CodePipeline)
Customer-facing API where a bad release costs money?     → blue/green, canary 10%, 5xx + latency alarms
Want to test on production infra before any user does?   → blue/green with a test listener
Big change, slow-burning risks (memory leaks)?           → linear shifting over 30 minutes, keep blue longer
Database schema change in the same release?              → expand/contract migrations: both versions must work with the schema
```

---

## ⚠️ Critical Mistakes

- **No alarms** on the deployment: CodeDeploy only rolls back what it can see fail.
- Deploying `latest`, or rebuilding the image per environment: dev and prod run different bits.
- **Terminating blue at once**: rollback becomes a 10-minute redeploy instead of an instant switch.
- A **schema migration** that the old version can't live with: rollback "succeeds" and blue breaks too. Add columns first, remove them in a later release.
- Alarms on **absolute counts** that misfire at night and miss at peak: use rates with a couple of datapoints.
- Forgetting that blue/green **doubles capacity** for a while: subnet IPs and Fargate quotas run out mid-deploy.
- Terraform resetting the **task definition or image** that the pipeline deployed.
- Pipeline credentials as long-lived **access keys** in CI secrets instead of OIDC or service roles.
- Building and testing in the same step with no **unit tests or image scan** before deploy.
- One NAT gateway, as in the sample, carried into production.
- No **notifications**: a failed deploy that rolled back silently looks like "my change is live".

---

## Interview Q&As

**Q: Walk me through what happens from git push to production.**

A: The push starts the pipeline. CodeBuild builds the image, tags it with the commit, pushes it to ECR and produces the task definition and appspec. The pipeline registers a new task definition revision, and CodeDeploy starts green tasks beside blue on a second target group, waits for health checks, optionally tests them on a test listener, then shifts production traffic. If a step fails or an alarm fires, it switches the listener back to blue. After a wait, blue is stopped and the result is announced.

**Q: Blue/green vs rolling: when would you use each?**

A: Rolling replaces tasks a few at a time in one target group: simpler, needs little spare capacity, and with the circuit breaker it rolls back releases that can't start. Blue/green runs a full second set: it costs double capacity briefly, but gives a test listener, controlled traffic shifting and instant rollback while blue is still running. Use blue/green where a bad release is expensive.

**Q: Canary or linear?**

A: Canary exposes a small slice (say 10%) for a fixed time, then everything: good when your alarms react quickly. Linear moves traffic in equal steps over time: spreads the risk and gives slow-burning problems time to show up, but deploys take longer.

**Q: What triggers an automatic rollback, and what can't it catch?**

A: Deployment failures (tasks that can't start or pass health checks) and any CloudWatch alarms you attach to the deployment group, such as green's 5xx rate or latency. It can't catch a release that returns wrong results with HTTP 200 unless you alarm on a business metric, like orders per minute or payment success rate.

**Q: How do you handle database changes with blue/green?**

A: Expand and contract: first deploy a migration that only adds (new columns, new tables) so both old and new code work; deploy the new code; later, once nothing reads the old shape, remove it in a separate release. Then rolling back the code never meets a schema it can't handle.

**Q: The sample uses one NAT gateway and two ALBs. Would you keep that?**

A: Not in production. One NAT per AZ, so an AZ failure doesn't cut off outbound traffic for the others. And one ALB with host or path rules can usually replace the two, saving an ALB's hourly cost, unless the two need different security settings.

**Q: Why tag images with the commit?**

A: So a task definition always means one exact build: you can see what's running, reproduce it, and roll back to a known image. `latest` changes under you, and two tasks of the "same" revision could run different code.

---

## Related topics

- [ECS on Fargate](/?topic=aws-ecs-fargate&read): services, task definitions, the circuit breaker
- [Application Load Balancer](/?topic=aws-alb&read): target groups and weighted forwarding
- [AWS IAM](/?topic=aws-iam&read): pipeline roles and GitHub OIDC
- [Terraform Remote State](/?topic=terraform-state&read) and [Terraform Modules](/?topic=terraform-modules&read): running the Terraform as a team
- [Disaster Recovery Across AWS Regions](/?topic=aws-disaster-recovery&read): when the whole region is the problem

---

## Sources

- [amazon-ecs-fullstack-app-terraform](https://github.com/aws-samples/amazon-ecs-fullstack-app-terraform) (MIT-0): the architecture and pipeline this topic follows
- [Blue/green deployments with CodeDeploy for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-bluegreen.html)
- [AppSpec file for an Amazon ECS deployment](https://docs.aws.amazon.com/codedeploy/latest/userguide/reference-appspec-file-structure-resources.html)
- [Deployment configurations on an ECS compute platform](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html)
- [Build specification reference for CodeBuild](https://docs.aws.amazon.com/codebuild/latest/userguide/build-spec-ref.html)
- [aws-actions/amazon-ecs-deploy-task-definition](https://github.com/aws-actions/amazon-ecs-deploy-task-definition)

---

## Why This Matters

✅ "How do you deploy safely?" is a standard follow-up to any design, and blue/green with canaries and alarm-driven rollback is the strong answer.

✅ The 23,400-vs-180 comparison is a concrete way to explain why alarms and canaries are worth setting up.

✅ Expand/contract migrations, commit-tagged images and keeping blue for a few minutes are the habits that make rollback actually work.
