# AWS VPC Networking: CIDR, Subnets, Route Tables, NAT, Security Groups and Endpoints

> 💡 **TL;DR**: A **VPC** is your own private network in one AWS region, with an address range you choose (`10.0.0.0/16`). You split it into **subnets**, each in one Availability Zone. A subnet is **public** only because its **route table** sends `0.0.0.0/0` to an **Internet Gateway**; **private** subnets reach out through a **NAT gateway** and can't be reached from outside. **Security groups** are stateful firewalls on each network interface, and they can name other security groups ("the database accepts 5432 from the app"). Send S3 and DynamoDB traffic through free **gateway endpoints**, give each zone its **own NAT gateway**, and pick a range big enough that you never run out.

Builds on [AWS Basics](/?topic=aws-basics&read). The [Application Load Balancer](/?topic=aws-alb&read) sits in the public subnets described here, and [ECS on Fargate](/?topic=aws-ecs-fargate&read) tasks run in the private ones.

---

## VPC at a glance

| Piece | What it does | Remember |
| --- | --- | --- |
| VPC | A private network in one region, with a CIDR range | The main range can't change later; you can add more ranges |
| CIDR block | An address range: `10.0.0.0/16` = first 16 bits fixed | Use private ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` |
| Subnet | A slice of the VPC in **one** AZ | 5 addresses in every subnet are reserved |
| Route table | Where packets for each destination go | Longest (most specific) prefix wins |
| Internet Gateway (IGW) | The VPC's door to the internet | Makes a subnet public when its route table points at it |
| NAT gateway | Lets private subnets open connections out, not in | Zonal; billed per hour and per GB |
| Elastic IP | A fixed public IPv4 address | Billed hourly, attached or not |
| Security group | Stateful firewall on a network interface | Allow rules only; can reference other security groups |
| Network ACL | Stateless firewall on a subnet | Allow and deny, numbered rules, both directions |
| Gateway endpoint | Free private route to S3 or DynamoDB | A route table entry, no hourly charge |
| Interface endpoint | A private IP in your subnet for an AWS API (PrivateLink) | Billed per hour per AZ and per GB |
| Peering / Transit Gateway | Connect VPCs together | Peering isn't transitive; ranges must not overlap |
| Flow logs | A record of accepted and rejected traffic | The first thing to read when "it can't connect" |

---

## CIDR in five minutes

An IPv4 address is 32 bits. In `10.0.0.0/16`, the first 16 bits are the network and the remaining 16 are free, so the range holds 2^16 = 65,536 addresses.

| Prefix | Addresses | Usable in an AWS subnet | Typical use |
| --- | --- | --- | --- |
| `/16` | 65,536 | (VPC) | The whole VPC: the largest AWS allows per range |
| `/20` | 4,096 | 4,091 | Private subnets for containers and Lambda |
| `/22` | 1,024 | 1,019 | Medium app subnets |
| `/24` | 256 | 251 | Public or database subnets |
| `/28` | 16 | 11 | The smallest subnet AWS allows |

Each step down in prefix **doubles** the size. A `/16` holds 2^(20−16) = 16 `/20`s, or 2^(24−16) = 256 `/24`s.

**Why 251 and not 256?** AWS keeps five addresses in every subnet. In `10.0.1.0/24`:

| Address | Reserved for |
| --- | --- |
| `10.0.1.0` | The network address |
| `10.0.1.1` | The VPC router |
| `10.0.1.2` | DNS (the Route 53 Resolver lives at the VPC base + 2) |
| `10.0.1.3` | Future use |
| `10.0.1.255` | Broadcast (unused in a VPC, still reserved) |

---

## The three-tier layout

The usual design: three tiers, repeated in every zone.

| Tier | Holds | Route to the internet | Example (3 AZs in Mumbai) |
| --- | --- | --- | --- |
| Public | Load balancers, NAT gateways | `0.0.0.0/0 → igw` | `10.0.0.0/24`, `10.0.1.0/24`, `10.0.2.0/24` |
| Private (app) | ECS tasks, EC2, Lambda in a VPC | `0.0.0.0/0 → nat` in the same AZ | `10.0.16.0/20`, `10.0.32.0/20`, `10.0.48.0/20` |
| Database | RDS, ElastiCache | none | `10.0.3.0/24`, `10.0.4.0/24`, `10.0.5.0/24` |

Nine subnets use 3 × 251 + 3 × 4,091 + 3 × 251 = 13,779 usable addresses, about a fifth of the `/16`, leaving room for more tiers or zones later. Container subnets are the big ones, because every Fargate task takes its own address, and a rolling deploy briefly needs twice the usual number.

```text
                         Internet
                            │
                     Internet Gateway
                            │
   ┌──────── public 10.0.0.0/24 (a) ─────┬──── public 10.0.1.0/24 (b) ─────┐
   │  ALB node      NAT gateway a        │  ALB node      NAT gateway b    │
   ├──────── private 10.0.16.0/20 (a) ───┼──── private 10.0.32.0/20 (b) ───┤
   │  app tasks ── 0.0.0.0/0 → NAT a     │  app tasks ── 0.0.0.0/0 → NAT b │
   ├──────── database 10.0.3.0/24 (a) ───┼──── database 10.0.4.0/24 (b) ───┤
   │  RDS primary ═══ sync ═══════════════► RDS standby                    │
   └─────────────────────────────────────┴─────────────────────────────────┘
```

---

## Route tables: what makes a subnet public

Every subnet is associated with one route table. For each packet, the most specific matching route wins.

**Public route table**

| Destination | Target |
| --- | --- |
| `10.0.0.0/16` | `local` (every VPC has it; can't be removed) |
| `0.0.0.0/0` | `igw-0a1b2c3d` |

**Private route table, zone a** (one per zone, each pointing at its own NAT)

| Destination | Target |
| --- | --- |
| `10.0.0.0/16` | `local` |
| `pl-…` (the prefix list of S3's addresses in ap-south-1) | `vpce-s3` (gateway endpoint) |
| `0.0.0.0/0` | `nat-zone-a` |

**Database route table**

| Destination | Target |
| --- | --- |
| `10.0.0.0/16` | `local` |

A task in zone a sends a backup to S3: the S3 prefix list is more specific than `0.0.0.0/0`, so it goes to the endpoint, free. It calls a payment API: only `0.0.0.0/0` matches, so it goes to the NAT gateway. The database tier has no way out at all.

---

## Getting out: Internet Gateway, NAT gateway, egress-only

| | Internet Gateway | NAT gateway | Egress-only Internet Gateway |
| --- | --- | --- | --- |
| Direction | In and out | Out only (replies come back) | Out only, IPv6 |
| Who uses it | Resources with public IPs in public subnets | Private subnets, over IPv4 | Private subnets, over IPv6 |
| Address seen outside | The resource's own public IP | The NAT's Elastic IP (allow-list it) | The resource's IPv6 address |
| Cost | Free (data transfer out still billed) | Per hour **and** per GB processed | Free (data transfer still billed) |
| Lives in | The VPC | One public subnet, one AZ | The VPC |

What a NAT gateway costs (us-east-1 list prices, the ones the topic's simulator uses):

- $0.045 an hour × 730 hours = **$32.85 a month** each, before any data.
- One per zone in 3 zones: **$98.55 a month**.
- Plus **$0.045 per GB** processed: 30 TB a month of S3 backups through it is 30,000 × $0.045 = **$1,350**. Through a gateway endpoint: **$0**.
- A NAT in another zone also adds cross-AZ transfer: $0.01 per GB in each direction.
- One NAT gateway handles up to 55,000 simultaneous connections to a single destination (IP, port and protocol). Thousands of connections to one API need connection reuse or more NAT addresses.

**One NAT gateway or one per zone?** One shared NAT is cheaper, but when its zone fails, every other zone loses outbound access too. That defeats the point of being multi-AZ. One per zone for production; one shared NAT for dev and test only.

---

## Security groups and network ACLs

| | Security group | Network ACL |
| --- | --- | --- |
| Attached to | A network interface (instance, task, load balancer, RDS) | A subnet |
| State | **Stateful**: replies are allowed automatically | **Stateless**: allow the reply direction too |
| Rules | Allow only | Allow and deny |
| Evaluation | All rules together | In order by rule number; first match wins |
| Source can be | CIDRs, prefix lists, **other security groups** | CIDRs only |
| Default | Deny all in, allow all out | The default NACL allows everything |

Chain security groups by reference, not by IP range, so scaling and replacement never need rule changes:

```text
alb-sg   inbound 443  from 0.0.0.0/0
app-sg   inbound 3000 from alb-sg      ← only the load balancer reaches the app
db-sg    inbound 5432 from app-sg      ← only the app reaches the database
```

NACLs are a coarse second layer, for example blocking an abusive range for a whole subnet. If you add one, remember the **ephemeral ports**: replies go back to the client's random port (1024 to 65535), so a stateless rule set must allow them outbound.

---

## VPC endpoints: reaching AWS without the internet

| | Gateway endpoint | Interface endpoint (PrivateLink) |
| --- | --- | --- |
| Services | S3 and DynamoDB only | Most AWS APIs (ECR, Secrets Manager, CloudWatch Logs, STS, SQS…) and partner services |
| How it works | A prefix-list route in your route tables | A network interface with a private IP in your subnets; DNS points the service name at it |
| Cost | Free | About $0.01 an hour per AZ plus $0.01 per GB (us-east-1) |
| Use when | Always, if you use S3 or DynamoDB | Private subnets with no NAT, heavy AWS API traffic, or compliance |

Endpoints also work with IAM conditions: a bucket policy with `aws:SourceVpce` makes the bucket readable **only** through your endpoint.

---

## Connecting networks

| Option | Connects | Notes |
| --- | --- | --- |
| VPC peering | Two VPCs (any account or region) | Not transitive: A–B and B–C doesn't give A–C; no overlapping ranges |
| Transit Gateway | Many VPCs and VPNs through a hub | Per-attachment hourly fee plus per-GB processing |
| PrivateLink | One service, exposed to other VPCs | Consumers see an interface endpoint; overlapping ranges are fine |
| Site-to-Site VPN | Your office or data centre, over the internet | Encrypted IPsec tunnels, quick to set up |
| Direct Connect | Your data centre, over a dedicated line | Consistent latency and bandwidth; weeks to provision |

Overlapping ranges are the trap that never goes away: two VPCs both on `10.0.0.0/16` can't be peered or routed through a Transit Gateway. Plan ranges per environment and per team up front (for example `10.0.0.0/16` prod, `10.1.0.0/16` staging, `10.2.0.0/16` dev).

---

## Building it with Terraform

```hcl
# Adapted from terraform-aws-modules/terraform-aws-vpc (Apache License 2.0)
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "payments"
  cidr = "10.0.0.0/16"
  azs  = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]

  public_subnets   = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"]
  private_subnets  = ["10.0.16.0/20", "10.0.32.0/20", "10.0.48.0/20"]
  database_subnets = ["10.0.3.0/24", "10.0.4.0/24", "10.0.5.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway     = false
  one_nat_gateway_per_az = true   # each zone survives on its own

  enable_dns_hostnames = true
  enable_dns_support   = true
}

# Free: S3 traffic from private subnets skips the NAT gateway
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.ap-south-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids
}

resource "aws_security_group" "db" {
  name   = "db"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]   # only the app, by reference
  }
}
```

---

## Debugging "it can't connect"

Work from the source outwards:

1. **Security group of the source**: outbound allowed? (The default allows all.)
2. **Security group of the destination**: inbound allowed from the source's security group or range, on the right port?
3. **NACLs** on both subnets: both directions, including ephemeral ports for replies.
4. **Route table** of the source subnet: is there a route for the destination? For the internet: `0.0.0.0/0 → nat-…` (private) or `→ igw-…` (public).
5. **NAT gateway**: in a **public** subnet, whose route table points at the IGW, and with an Elastic IP.
6. **DNS**: does the name resolve to what you expect (VPC DNS support and hostnames on; private hosted zones attached)?
7. **The other side**: is your NAT's Elastic IP on the partner's allow-list?
8. **Flow logs**: a `REJECT` names the interface and port; an `ACCEPT` with no reply points at the return path.

```text
# VPC flow log record: version account interface src dst srcport dstport protocol packets bytes start end action status
2 111122223333 eni-0a1b2c3d4e5f60718 10.0.16.25 203.0.113.10 49152 443 6 10 840 1763020800 1763020860 ACCEPT OK
2 111122223333 eni-0f9e8d7c6b5a40312 198.51.100.7 10.0.3.14 51515 5432 6 1 60 1763020800 1763020860 REJECT OK
```

The second line is someone on the internet trying the database port, and being refused: what you want to see.

---

## How to choose

```text
Load balancer, NAT gateway, bastion?             → public subnet
Application servers, containers, Lambda in VPC?  → private subnet (own NAT per AZ if it calls out)
Databases and caches?                            → database subnet, no internet route
S3 or DynamoDB from private subnets?             → gateway endpoint (free), always
Other AWS APIs with no NAT, or lots of traffic?  → interface endpoints
Two or three VPCs to connect?                    → peering
Many VPCs, VPNs and accounts?                    → Transit Gateway
Expose one service to other accounts?            → PrivateLink
Admin access to private servers?                 → SSM Session Manager (no open port 22, no bastion)
```

---

## ⚠️ Critical Mistakes

- A **small or overlapping VPC range**: you run out of addresses, or can never connect it to another network.
- Calling a subnet "public" by name: only the **route to the IGW** makes it public.
- **One NAT gateway for all zones** in production: one zone failing cuts off the others' outbound traffic.
- **S3 traffic through NAT**: paying $0.045 per GB for what a free gateway endpoint does.
- **Databases in public subnets**, or with a public IP "for debugging".
- Security groups with `0.0.0.0/0` on 22, 3306, 5432 or 6379.
- Rules by **IP range** between your own tiers instead of by **security group reference**: break on every scale-out.
- Tight **/24 subnets for Fargate**: a rolling deploy needs double the addresses and gets stuck in PENDING.
- **NACL rules without ephemeral ports**: requests go out, replies never come back.
- Leaving **unused Elastic IPs and NAT gateways** running in dev: both bill by the hour.
- Opening **port 22** to the world for SSH, instead of SSM Session Manager.
- No **flow logs**: debugging network issues by guessing.

---

## Interview Q&As

**Q: What actually makes a subnet public?**

A: Its route table. A public subnet's route table has `0.0.0.0/0` pointing at the VPC's Internet Gateway, and resources in it need a public IP to be reachable. A private subnet has no such route; it reaches the internet, if at all, through a NAT gateway in a public subnet.

**Q: Why does a /24 subnet give you 251 usable addresses?**

A: A /24 has 2^8 = 256 addresses, and AWS reserves five in every subnet: the network address, .1 for the VPC router, .2 for DNS, .3 for future use, and the last one (broadcast).

**Q: Your private tasks can't reach an outside API. What do you check, in order?**

A: The task's security group outbound rules; the subnet's route table for `0.0.0.0/0 → nat`; that the NAT gateway is in a public subnet whose route table points at the IGW and has an Elastic IP; NACLs in both directions including ephemeral ports; DNS resolution; whether the API allow-lists the NAT's IP. Flow logs show where packets are rejected.

**Q: One NAT gateway or one per zone? What does each cost, and what fails?**

A: One per zone costs more (three NATs at about $32.85 a month each in us-east-1, before data) but each zone keeps outbound access when another fails, and there's no cross-AZ data charge. A single NAT is cheaper but becomes a single point of failure for every zone's outbound traffic. Production: one per zone. Dev: one is fine.

**Q: How do you stop paying NAT charges for S3 traffic?**

A: Add an S3 gateway endpoint to the private route tables. Its prefix-list route is more specific than `0.0.0.0/0`, so S3 traffic takes the endpoint: no NAT, no internet, no per-GB processing charge. DynamoDB has a gateway endpoint too. Other AWS APIs need interface endpoints, which are charged.

**Q: Security group vs network ACL?**

A: A security group is a stateful firewall on a network interface with allow rules only; replies are allowed automatically, and rules can reference other security groups. A NACL is a stateless firewall on a subnet with numbered allow and deny rules, evaluated in order, so replies must be allowed explicitly. Security groups do the real work; NACLs are a coarse extra layer.

**Q: How do you connect this VPC to another company's network with an overlapping range?**

A: Peering and Transit Gateway can't route overlapping ranges. Use PrivateLink: they expose their service through an endpoint service, and you get an interface endpoint with an address in your own range. Otherwise NAT between the networks, or re-address one side.

**Q: How do you give engineers access to servers in private subnets?**

A: SSM Session Manager: a shell through the SSM agent, authorised by IAM and logged, with no inbound port open and no bastion host. If you must SSH, a bastion in a public subnet with its security group open only to known IPs.

**Q: How many addresses do you need for Fargate?**

A: One per task, plus headroom for deploys: a rolling deploy can run old and new tasks side by side, so plan for at least double the steady count, plus load balancer nodes and interface endpoints. That's why app subnets are often /20 or larger.

---

## Related topics

- [AWS Basics](/?topic=aws-basics&read): regions and Availability Zones
- [Application Load Balancer](/?topic=aws-alb&read): what lives in the public subnets
- [ECS on Fargate](/?topic=aws-ecs-fargate&read): tasks in the private subnets, each with its own address
- [AWS IAM](/?topic=aws-iam&read): `aws:SourceVpce` conditions for endpoint-only buckets
- [Terraform Modules](/?topic=terraform-modules&read): building this VPC once for every environment

---

## Sources

- [How Amazon VPC works](https://docs.aws.amazon.com/vpc/latest/userguide/how-it-works.html)
- [Subnet CIDR blocks (the five reserved addresses)](https://docs.aws.amazon.com/vpc/latest/userguide/subnet-sizing.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) and [Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/)
- [Gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html)
- [Control traffic with security groups](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html)
- [terraform-aws-modules/vpc](https://github.com/terraform-aws-modules/terraform-aws-vpc) (Apache 2.0)

---

## Why This Matters

✅ Every AWS architecture diagram is drawn on top of a VPC: knowing what makes a subnet public and why the database has no route out lets you defend the boxes you draw.

✅ NAT gateway per zone, gateway endpoints for S3 and subnet sizing for containers are the details that separate a real design from a diagram, and they show up on the bill.

✅ "Security groups reference security groups" and the debugging checklist will save you hours the first time something can't connect.
