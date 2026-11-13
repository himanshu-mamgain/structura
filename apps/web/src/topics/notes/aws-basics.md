# AWS Basics: Regions, Compute, Storage, Pricing and the Shared Responsibility Model

> 💡 **TL;DR**: AWS rents you computers, storage, databases and networks **through an API**, billed by the second, the request or the gigabyte. Pick a **Region** near your users (Mumbai is `ap-south-1`) and spread across at least two **Availability Zones** (separate data centres) so one failure doesn't take you down. Run code on **EC2** (virtual servers), **containers** (ECS, EKS, Fargate) or **Lambda** (functions per request). Keep files in **S3** and data in **RDS** or **DynamoDB**. Control who can do what with **IAM**, and watch everything in **CloudWatch**. AWS secures the data centres; **you** secure your accounts, data and configuration. The cloud is cheap when it follows your traffic and expensive when you forget it's running.

This is the first step of the AWS part of the roadmap. Next: [Scaling to Millions of Users on AWS](/?topic=scaling-aws&read) puts these pieces together, and [AWS IAM](/?topic=aws-iam&read) covers who can touch them.

---

## AWS at a glance

| Need | Service | One line |
| --- | --- | --- |
| A server | **EC2** | A virtual machine you pick by size, billed by the second |
| Containers | **ECS**, **EKS**, **Fargate** | Run Docker images; Fargate means no servers to manage |
| Code per request | **Lambda** | A function AWS runs per event, billed per request and millisecond |
| Files | **S3** | Object storage: any file, any amount, eleven nines of durability |
| A disk for a server | **EBS** | A network-attached disk for one EC2 instance |
| SQL database | **RDS**, **Aurora** | Managed Postgres or MySQL with backups and failover |
| Key-value database | **DynamoDB** | Single-digit-millisecond reads at any scale, pay per request |
| Cache | **ElastiCache** | Managed Redis or Valkey |
| Your private network | **VPC** | Subnets, route tables and firewalls for your resources |
| Spreading traffic | **ELB** (ALB, NLB) | Load balancers across servers and zones |
| DNS and CDN | **Route 53**, **CloudFront** | Domain names, and caching close to users |
| Messaging | **SQS**, **SNS**, **EventBridge** | Queues, fan-out notifications, event routing |
| Streaming | **Kinesis**, **MSK** | Event streams; MSK is managed Kafka |
| Who can do what | **IAM** | Users, roles and policies for every API call |
| Secrets and keys | **Secrets Manager**, **KMS** | Store passwords; manage encryption keys |
| Watching it all | **CloudWatch**, **CloudTrail** | Metrics, logs and alarms; a record of every API call |
| Infrastructure as code | **CloudFormation**, **CDK** (or Terraform) | Describe resources in files instead of clicking |

---

## Why the cloud: buy vs rent

Before the cloud you **bought servers for your busiest hour**, waited weeks for delivery, and they sat mostly idle the rest of the day. If a sale brought more traffic than you planned for, there was nothing to add in time.

The topic's simulator runs a month of a food-delivery app (60 req/s at night, 1,200 req/s at dinner, about **1.03 billion requests**) four ways, with Mumbai prices:

| Approach | Up front | A month | Capacity used | Catch |
| --- | --- | --- | --- | --- |
| 8 servers you buy | $14,400 | $560 | 24.8% | Weeks to add more; you run them |
| 8 rented EC2 servers (m6i.large) | $0 | $582 | 24.8% | Paying for the dinner peak all night |
| EC2 with Auto Scaling (2 to 9 servers) | $0 | about $270 | 53% | A few minutes of strain at each ramp-up |
| Lambda (100 ms, 512 MB) | $0 | about $1,062 | 100% | Per-request price adds up at steady load |

What the cloud really sells:

- **Elasticity**: capacity that follows traffic, in minutes, without buying anything.
- **No up-front cost**: billed by the second (EC2 on Linux, minimum 60 s), the request (Lambda) or the gigabyte (S3).
- **Reliability you'd struggle to build**: several data centres per region, managed failover.
- **Managed services**: AWS patches, backs up and fails over the database; you use it.

Owning can still win for **large, steady, predictable** load with a team to run it. Renting wins on speed, spikes, experiments and anything small.

---

## Regions, Availability Zones and edge locations

```text
Region: ap-south-1 (Mumbai)
├── AZ ap-south-1a   ← one or more data centres, own power, cooling and network
├── AZ ap-south-1b   ← kilometres apart (within ~100 km), private fibre, single-digit ms
└── AZ ap-south-1c
Region: ap-south-2 (Hyderabad)  ← a separate region: independent, far away
Edge locations: hundreds of small sites for CloudFront and Route 53, close to users
```

- A **Region** is a geographic area with its own, independent copy of AWS: more than 30 worldwide, each with **three or more AZs**. India has Mumbai (`ap-south-1`) and Hyderabad (`ap-south-2`).
- An **Availability Zone** is one or more data centres with independent power and networking. Zones in a region are close enough for synchronous database copies, far enough apart that one fire or flood doesn't hit two.
- **Choose a region by**: latency to your users, where your data is legally allowed to live, which services and instance types it offers, and price (US East is usually cheapest; Mumbai costs a little more).
- **Spread across at least two AZs** for anything that must stay up. Surviving a whole region going down is a disaster-recovery decision: see [Disaster Recovery Across AWS Regions](/?topic=aws-disaster-recovery&read).
- Most services are **regional** (EC2, RDS, Lambda, S3 buckets). A few are **global** (IAM, Route 53, CloudFront).

---

## Compute: EC2, containers or Lambda

### EC2: a virtual server

An EC2 **instance** is a VM on AWS's Nitro hypervisor. You choose an **AMI** (the disk image: Amazon Linux, Ubuntu), an **instance type** (CPU and memory), a subnet, a security group and a disk.

How to read an instance type, `m6i.large`:

| Part | Means | Other values |
| --- | --- | --- |
| `m` | Family: general purpose | `c` compute, `r` memory, `t` burstable, `g`/`p` GPU, `i` storage |
| `6` | Generation | Newer is usually faster and cheaper per unit of work |
| `i` | Processor: Intel | `a` AMD, `g` Graviton (AWS's ARM chips, usually the best price for performance) |
| `large` | Size | `large` = 2 vCPU and 8 GiB for `m`; each step up (`xlarge`, `2xlarge`) doubles it |

- **EBS** volumes are network disks: they survive a stop and start. **Instance store** disks are physically attached and fast, but wiped when the instance stops.
- **`t` instances** are burstable: they earn CPU credits while idle and spend them when busy. Under steady load they run out. T3 and newer default to unlimited mode, which bills extra for the CPU above the baseline; in standard mode they slow down instead.

### Auto Scaling

An **Auto Scaling group** keeps between `min` and `max` instances from a **launch template**, spread over the zones you list. A **target tracking** policy keeps a metric near a value: "average CPU 70%". It also replaces instances that fail health checks.

New instances take minutes (boot, start the app, pass health checks). So the first minutes of a sudden spike are carried by the old fleet: keep headroom, and use **scheduled scaling** for peaks you know about, such as the dinner rush.

### Lambda: no servers

You upload a function; AWS runs a copy for every request in flight and bills $0.20 per million requests plus $0.0000166667 per GB-second.

- **Concurrency** = requests per second × seconds per request. 4,000 req/s at 100 ms is 400 copies at once (the default limit is 1,000 per region; ask for more before you need it).
- **Cold start**: the first request to a new copy waits while it starts (from about a hundred milliseconds to over a second, longer for big packages or Java).
- Limits: up to 15 minutes per run, 128 MB to 10 GB of memory.

**Where Lambda stops being cheap**: at 100 ms and 512 MB, a request costs about $1.03 per million, so sustained traffic costs about $0.0037 an hour per req/s. One m6i.large ($0.101/hour) serves about 200 req/s. They cost the same at about **27 req/s** of steady traffic, and above that servers win. That's why Lambda is the most expensive option in the simulator's busy month, and the cheapest for a quiet one.

### How to choose

```text
Spiky or low traffic, event-driven glue (S3 upload → resize)?   → Lambda
You have Docker images, steady traffic, no wish to manage VMs?    → ECS on Fargate
Steady high traffic, need full control, cheapest per request?     → EC2 (or ECS on EC2) with Auto Scaling
Already run Kubernetes, or need its ecosystem?                    → EKS
Long jobs, GPUs, special hardware?                                → EC2
```

---

## Storage and databases

| Service | Type | Use for | Remember |
| --- | --- | --- | --- |
| **S3** | Object storage over HTTP | Uploads, images, backups, static sites, data lakes | Not a file system: whole objects, no appending; storage classes make old data cheaper |
| **EBS** | Block disk, one instance | The disk of an EC2 server | Lives in one AZ; snapshot it to S3 for backups |
| **EFS** | Shared file system (NFS) | Files many servers must share | Costs more per GB than S3 |
| **RDS / Aurora** | Managed SQL | Orders, users, payments | Multi-AZ keeps a standby in another zone; failover takes about 1 to 2 minutes |
| **DynamoDB** | Managed key-value | Sessions, carts, huge scale with known access patterns | Design keys around your queries; scans are slow and costly |
| **ElastiCache** | Managed Redis / Valkey | Caching, sessions, leaderboards, rate limits | A cache, not the source of truth |

Managed services cost more than running the same software on EC2, but AWS does the patching, backups, replication and failover. For most teams that trade is worth it.

---

## Networking in one picture

```text
Internet
   │
Route 53 (DNS) ─► CloudFront (CDN, optional)
   │
Application Load Balancer   ← public subnets in zones a and b
   │
EC2 / ECS tasks             ← private subnets: no public IP
   │
RDS primary (zone a) ──sync──► RDS standby (zone b)
```

- A **VPC** is your private network in a region, split into **subnets**, each in one AZ.
- **Public subnets** route to the internet through an Internet Gateway; **private subnets** reach out through a NAT gateway and can't be reached from outside.
- **Security groups** are firewalls on each resource: "the database accepts port 5432 only from the app's security group".
- The details are in [VPC Networking](/?topic=aws-vpc&read) and [Application Load Balancer](/?topic=aws-alb&read).

---

## Pricing models and where bills go wrong

| Model | Discount on On-Demand | For |
| --- | --- | --- |
| **On-Demand** | none | Anything new, spiky or short-lived |
| **Savings Plans** | up to 72% | Steady use you'll keep for 1 or 3 years (commit to $ per hour) |
| **Reserved Instances** | up to 72% | Same idea, tied to an instance type (RDS, ElastiCache, older setups) |
| **Spot** | up to 90% | Work that can stop: batch jobs, CI, workers. AWS can take it back with 2 minutes' notice |
| **Free Tier** | free | New accounts get credits and a free plan to try things; some services have always-free amounts (Lambda: 1 million requests a month) |

Where surprise bills come from:

- **Forgotten resources**: a test instance, an unattached EBS volume, old snapshots, a load balancer for a deleted app.
- **NAT gateways**: billed by the hour **and** per GB processed (about $0.045 each in us-east-1). Send S3 and DynamoDB traffic through free gateway endpoints instead.
- **Data transfer out** to the internet (the first 100 GB a month are free) and **across AZs** ($0.01 per GB in each direction).
- **Public IPv4 addresses**: $0.005 an hour each, even idle.
- **CloudWatch Logs** from chatty apps: ingestion is charged per GB.
- **Leaked access keys**: someone mines crypto on your account. Protect the root user and never commit keys.

Set an **AWS Budget** with an email alert on day one, and tag everything with an owner and a project so Cost Explorer can tell you who spent what.

---

## Shared responsibility

| AWS secures ("security **of** the cloud") | You secure ("security **in** the cloud") |
| --- | --- |
| Data centres, guards, power, cooling | Your AWS accounts, users, roles and MFA |
| Physical servers, storage, network | Who can reach what: security groups, public buckets |
| The hypervisor and the managed service software | Your OS patches on EC2, your container images, your code |
| Availability of the services as promised | Encryption settings, backups you turned on, keys |

The more managed the service, the more AWS takes on: on EC2 you patch the OS; on RDS AWS patches the database engine; on Lambda AWS runs everything below your function. A public S3 bucket or a leaked key is always your side.

---

## Your first hour on AWS

1. **Lock the root user**: the email you signed up with. Turn on MFA, then stop using it.
2. **Create a day-to-day sign-in** with IAM Identity Center (or an IAM user with MFA), with admin rights only while you're learning alone.
3. **Set a budget alert** at a number you'd be unhappy to pay.
4. **Pick your region** (`ap-south-1`) and stay in it, so nothing hides in a region you never look at.
5. **Install the AWS CLI** and sign in with `aws configure sso`: short-lived credentials, no keys in files.
6. **Tag everything** you create, and delete it when you're done.

```bash
# Who am I signed in as?
aws sts get-caller-identity

# The zones in Mumbai
aws ec2 describe-availability-zones --region ap-south-1 \
  --query 'AvailabilityZones[].ZoneName' --output text
# ap-south-1a  ap-south-1b  ap-south-1c

# An email when this month's spend passes 80% of $50
aws budgets create-budget --account-id 123456789012 \
  --budget '{"BudgetName":"monthly","BudgetLimit":{"Amount":"50","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]}]'
```

### Calling AWS from Node

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// No keys in code: on EC2, ECS or Lambda the SDK picks up the role's
// short-lived credentials automatically; on your laptop, your SSO sign-in.
const s3 = new S3Client({ region: 'ap-south-1' });

await s3.send(new PutObjectCommand({
  Bucket: 'priya-menu-photos-2026',
  Key: 'menus/paneer-tikka.jpg',
  Body: imageBuffer,
  ContentType: 'image/jpeg',
}));

// Let a browser upload straight to S3 for the next 5 minutes, without passing through your server
const uploadUrl = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket: 'priya-menu-photos-2026', Key: `uploads/${crypto.randomUUID()}.jpg` }),
  { expiresIn: 300 },
);
```

---

## A typical first architecture

```text
Users → Route 53 → CloudFront ─► S3 (the React app, images)
                       │
                       └─► ALB → ECS on Fargate (API, 2+ tasks in 2 AZs)
                                     ├─► RDS Postgres (Multi-AZ)
                                     ├─► ElastiCache Redis (sessions, cache)
                                     └─► SQS → worker tasks (emails, receipts)
CloudWatch: logs, metrics, alarms · IAM roles for every task · Secrets Manager for passwords
```

Each box is a managed service that scales on its own, every tier runs in at least two zones, and nothing in the private subnets has a public address. [Scaling to Millions of Users on AWS](/?topic=scaling-aws&read) builds this up one bottleneck at a time.

---

## ⚠️ Critical Mistakes

- Using the **root user** day to day, or without MFA. If it leaks, everything goes with it.
- **Access keys in code** or in a public repo: bots find them within minutes. Use roles and SSO.
- **No budget alert**: the first sign of a mistake is the invoice.
- **Everything in one AZ**: one data centre problem takes the whole app down. Use at least two.
- A **public S3 bucket** holding private files. Keep Block Public Access on; share with presigned URLs.
- **Databases in public subnets**, or security groups open to `0.0.0.0/0` on 22, 3306 or 5432.
- **Burstable `t` instances** for steady load: they run out of CPU credits and either slow down or bill extra.
- Treating **Lambda** as free at any scale: sustained traffic is cheaper on servers.
- Sending S3 traffic **through a NAT gateway**: you pay per GB for what a free gateway endpoint does.
- **Clicking everything in the console** for production: nobody can review or rebuild it. Use Terraform or CloudFormation.
- **No tags**: you can't tell what a resource is for, so nobody dares delete it, and it bills forever.
- Asking for a **quota increase** (Lambda concurrency, vCPUs) on the day of the sale instead of weeks before.

---

## Interview Q&As

**Q: What's the difference between a Region and an Availability Zone?**

A: A Region is a separate geographic copy of AWS, such as Mumbai. An Availability Zone is one or more data centres inside a region, with independent power and networking, kilometres from the others (within about 100 km) and linked by low-latency fibre. You spread across AZs for high availability (synchronous replication is possible), and across Regions for disaster recovery and users far away.

**Q: Why use the cloud instead of buying servers?**

A: Elasticity (capacity follows traffic in minutes), no up-front cost, built-in redundancy across data centres, and managed services so you don't run databases and load balancers yourself. Owning can be cheaper for large, steady and predictable load if you have a team to run it, which is why some very large companies run their own hardware.

**Q: How does Auto Scaling work, and what goes wrong in a sudden spike?**

A: An Auto Scaling group keeps between a minimum and maximum number of instances. A target-tracking policy adds instances when a metric (say average CPU) goes above the target and removes them when it falls. New instances take minutes to boot and pass health checks, so the existing fleet carries the spike until then: keep headroom, scale on a leading metric such as requests per target, and schedule capacity before known peaks.

**Q: When would you choose Lambda over EC2, and when not?**

A: Lambda for spiky or low traffic, event-driven work (an S3 upload, a queue message, a cron) and small APIs: no servers, scales to zero, billed per request. Not for steady high traffic (per-request pricing gets more expensive than servers above a few dozen requests a second per server it replaces), long jobs over 15 minutes, or latency-critical paths that can't tolerate cold starts.

**Q: What is the shared responsibility model?**

A: AWS secures the cloud itself: data centres, hardware, network and the software that runs managed services. You secure what you put in it: accounts, IAM, network rules, OS patches on EC2, your code and your data's encryption and backups. The more managed the service, the more AWS covers, but configuration mistakes like a public bucket are always yours.

**Q: How do you keep an AWS bill under control?**

A: Budgets and alerts from day one, tags on everything so Cost Explorer shows who spends what, Auto Scaling so capacity follows traffic, Savings Plans for the steady baseline and Spot for interruptible work, S3 lifecycle rules for old data, VPC endpoints instead of NAT for AWS traffic, and regular clean-ups of idle resources.

**Q: Which AWS services would you use for a typical web app?**

A: Route 53 and CloudFront in front; the static frontend in S3; the API on ECS Fargate or EC2 behind an Application Load Balancer, across two AZs in private subnets; RDS Postgres Multi-AZ for data; ElastiCache for caching and sessions; SQS for background jobs; IAM roles for every component, Secrets Manager for passwords and CloudWatch for logs, metrics and alarms.

**Q: S3 vs EBS vs EFS?**

A: S3 is object storage over HTTP: unlimited, very durable, for files and backups, but not a mountable disk. EBS is a block disk attached to one EC2 instance in one AZ: the server's hard drive. EFS is a shared network file system many instances can mount at once. Pick S3 unless the software needs a real file system.

**Q: What happens to your app if an Availability Zone fails?**

A: If you run in two or more AZs: the load balancer's health checks stop sending traffic to the failed zone, Auto Scaling launches replacements in the healthy ones, and RDS Multi-AZ promotes its standby in about one to two minutes. If everything is in one AZ, you're down until it comes back.

---

## Related topics

- [Scaling to Millions of Users on AWS](/?topic=scaling-aws&read): from one server to a sharded fleet, one bottleneck at a time
- [AWS IAM](/?topic=aws-iam&read): users, roles and policies
- [VPC Networking](/?topic=aws-vpc&read): subnets, route tables and NAT gateways
- [Application Load Balancer](/?topic=aws-alb&read): listeners, target groups and health checks
- [ECS on Fargate](/?topic=aws-ecs-fargate&read): running containers without servers
- [Docker](/?topic=docker-vs-vm&read): the images you'll run on ECS
- [Disaster Recovery Across AWS Regions](/?topic=aws-disaster-recovery&read): surviving a whole region going down

---

## Sources

- [AWS Global Infrastructure](https://aws.amazon.com/about-aws/global-infrastructure/)
- [Amazon EC2 instance types](https://aws.amazon.com/ec2/instance-types/) and [On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [AWS Free Tier update, July 2025](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan)

---

## Why This Matters

✅ Every system design answer ends with "and we'd run it on…": knowing what EC2, S3, RDS, Lambda and an ALB each do lets you say it in AWS's words.

✅ Regions vs AZs, Auto Scaling's lag and the Lambda-vs-servers cost crossover are classic follow-up questions, and the numbers above let you answer with figures instead of adjectives.

✅ A budget alert, MFA on root and no keys in code will save you real money and real incidents in your first week on AWS.
