# Disaster Recovery Across AWS Regions: RTO, RPO, the Four Strategies and Why Replicas Aren't Backups

> 💡 **TL;DR**: Disaster recovery is planning for the day **a whole region** (or your data itself) is gone. Two numbers drive every choice: **RTO**, how long you can be down, and **RPO**, how much recent data you can lose. AWS's four strategies trade cost for those numbers: **backup and restore** (hours, cheapest), **pilot light** (tens of minutes: data replicated, servers off), **warm standby** (minutes: a small live copy) and **multi-site active/active** (seconds, about double the cost). **Multi-AZ is high availability, not DR.** **Replicas copy mistakes instantly**, so you still need point-in-time backups, copied to another region and ideally another account. And DR you've never tested doesn't work.

Builds on [AWS Basics](/?topic=aws-basics&read) (regions and AZs) and [Scaling to Millions of Users on AWS](/?topic=scaling-aws&read). The example: an orders system in **Mumbai** (`ap-south-1`) recovering to **Hyderabad** (`ap-south-2`).

---

## The words at a glance

| Term | Means | Example |
| --- | --- | --- |
| **RTO** (recovery time objective) | The longest you can be down | "Back within 30 minutes" |
| **RPO** (recovery point objective) | The most recent data you can lose, as time | "Lose at most 1 minute of orders" |
| High availability | Surviving the failure of a part: a server, an AZ | Multi-AZ RDS, an ALB over 2 AZs |
| Disaster recovery | Surviving the loss of a region, the data, or the account | A second region, backups elsewhere |
| Failover | Moving users to the recovery side | Route 53 starts answering with Hyderabad |
| Failback | Moving them home again | A second migration, planned like the first |
| PITR | Point-in-time recovery: restore to any second in a window | RDS and DynamoDB, up to 35 days |
| Game day | A rehearsal where you really fail over | Twice a year, on a weekday |

---

## What can go wrong, and what saves you

| Disaster | Multi-AZ helps? | Cross-region replica helps? | Backups help? |
| --- | --- | --- | --- |
| One server dies | Yes | Not needed | Not needed |
| One Availability Zone fails | **Yes**: this is what it's for | Not needed | Not needed |
| The whole region is down for hours | No | **Yes** | Only if copied to another region |
| A bug or a person deletes the orders table | No: the standby deletes it too | **No: it replicates the delete in seconds** | **Yes**: restore to just before |
| Ransomware or a stolen admin key wipes the account | No | No, if in the same account | Only if in **another account**, locked |

The single most important line in this note: **a replica is not a backup.** Replication faithfully copies every write, including `DROP TABLE orders`.

---

## The four strategies

| Strategy | What runs in Hyderabad | RTO (topic) | RPO | Standby cost against a $2,000 stack |
| --- | --- | --- | --- | --- |
| **Backup and restore** | Nothing: Terraform and copied backups | ~155 min | Hours (to the last copied backup) | $0, plus backup storage |
| **Pilot light** | The database, as an async replica; servers defined but at zero | ~30 min | Seconds | ~$400 a month |
| **Warm standby** | A small but complete copy: replica, 2 servers, load balancer | ~10 min | Seconds | ~$850 a month |
| **Multi-site active/active** | A full copy serving users all the time | ~2 min | ~1 s | ~$2,100 a month |

The costs are illustrative, the durations are the topic simulator's assumptions, and the totals below are computed from them.

### Where the RTO minutes go

```text
Backup and restore   30 decide + 45 Terraform builds the stack + 60 restore 500 GB + 15 test + 5 DNS = 155 min
Pilot light          15 decide + 10 promote replica (servers boot meanwhile)                + 5 DNS = 30 min
Warm standby          2 health checks + DNS, then 8 min automated promotion and scale-up            = 10 min
Active/active         2 health checks + DNS: the other region is already serving                     = ~2 min
```

### What the RPO costs in orders

At **1,500 orders an hour** (25 a minute), with the disaster at 6 p.m.:

| Data protection | Data lost | Orders lost |
| --- | --- | --- |
| Nightly snapshot at 2 a.m., copied to Hyderabad | 16 hours | 16 × 1,500 = **24,000** |
| Nightly snapshot, **same region only** | Can't restore until Mumbai is back | Down for the whole 6-hour outage |
| Cross-region PITR (logs arrive within ~10 minutes) | ~10 minutes | 10 × 25 = **250** |
| Cross-region async replica (~5 s behind) | ~5 seconds | 25 ÷ 60 × 5 ≈ **2** |
| Global database (~1 s) | ~1 second | under 1 |

Most systems need **warm standby at most**. Active/active is for the few where minutes of downtime cost more than running a second region.

---

## Setting RTO and RPO

They're business decisions, not technical ones, and they differ per system:

| System | Reasonable RTO | Reasonable RPO | Strategy |
| --- | --- | --- | --- |
| Payments ledger | Minutes | Near zero | Warm standby or active/active, global database |
| Orders API | 30 minutes | 1 minute | Pilot light or warm standby |
| Admin panel | A few hours | 1 hour | Backup and restore |
| Analytics dashboard | A day | A day | Backup and restore (or rebuild from source) |

Ask: what does an hour down cost? What does losing ten minutes of data cost (refunds, angry customers, regulators)? Then pick the **cheapest** strategy that meets both numbers.

---

## Data: replication and backups per service

| Service | Cross-region replication | Backups and PITR |
| --- | --- | --- |
| **RDS** (Postgres, MySQL) | Cross-region read replica (async); promote it to take over | Automated backups with PITR up to 35 days; copy snapshots and automated backups to another region |
| **Aurora** | **Global Database**: storage-level replication, typically under a second; managed failover | PITR up to 35 days; snapshots copied cross-region |
| **DynamoDB** | **Global tables**: every region writable, conflicts resolved last-writer-wins | PITR up to 35 days; on-demand backups |
| **S3** | Cross-Region Replication (Replication Time Control for a 15-minute target) | **Versioning** (undo deletes and overwrites), **Object Lock** (can't be deleted) |
| **EBS / EC2** | Copy snapshots and AMIs to the other region | Snapshots on a schedule (AWS Backup) |
| **ElastiCache** | Global Datastore for Redis/Valkey | Usually rebuilt from the database instead |

**AWS Backup** puts it in one place: a backup plan per resource type, **copy rules** to another region and **another account**, and **Vault Lock** in compliance mode so nobody, not even the root user, can delete backups before they expire.

```bash
# Recover from "a bug deleted the orders table at 12:30": restore to 12:29 as a new instance
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier orders \
  --target-db-instance-identifier orders-restored-1229 \
  --restore-time 2026-11-13T06:59:00Z      # 12:29 IST in UTC

# Region gone: make the Hyderabad replica a standalone, writable database
aws rds promote-read-replica --db-instance-identifier orders-hyd --region ap-south-2
```

---

## Moving users: DNS failover

```hcl
resource "aws_route53_health_check" "mumbai" {
  fqdn              = "mumbai-alb.example.com"
  type              = "HTTPS"
  resource_path     = "/status"
  request_interval  = 10   # seconds
  failure_threshold = 3    # 3 failures in a row → unhealthy, about 30 s
}

resource "aws_route53_record" "api_primary" {
  zone_id         = aws_route53_zone.main.zone_id
  name            = "api.example.com"
  type            = "A"
  set_identifier  = "mumbai"
  health_check_id = aws_route53_health_check.mumbai.id
  failover_routing_policy { type = "PRIMARY" }
  alias {
    name                   = aws_lb.mumbai.dns_name
    zone_id                = aws_lb.mumbai.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_secondary" {
  zone_id        = aws_route53_zone.main.zone_id
  name           = "api.example.com"
  type           = "A"
  set_identifier = "hyderabad"
  failover_routing_policy { type = "SECONDARY" }
  alias {
    name                   = aws_lb.hyderabad.dns_name
    zone_id                = aws_lb.hyderabad.zone_id
    evaluate_target_health = true
  }
}
```

- Route 53 **health checks** plus **failover** (or latency) routing move users when the primary is unhealthy. Alias records to load balancers follow the change quickly; for plain records keep the **TTL low** (60 s) on anything that moves.
- **Application Recovery Controller** adds manual "routing controls" and readiness checks, so a human can flip regions with one safe, pre-tested switch.
- Prefer **data plane** actions during an incident (health checks flipping DNS, promoting a replica) over **control plane** ones (creating new resources), which may be slow or impaired in a regional event. That's called **static stability**: the recovery side already exists and only needs traffic.

---

## The failover runbook

1. **Declare.** One named person decides "this is a disaster". Failing over by mistake is costly too.
2. **Stop writes to the old primary** if it's still partly reachable, so you don't end up with two sources of truth.
3. **Promote** the data in the recovery region (replica, Global Database failover, or restore).
4. **Scale up** the app in the recovery region to production size (pilot light: from zero; warm standby: from small).
5. **Move traffic**: health checks and failover records, or the routing control.
6. **Verify** with smoke tests and real metrics; tell customers.
7. **Reconcile**: async replication may have lost the last seconds; compare against payment-provider records and re-create what's missing.
8. **Fail back later**, deliberately: re-sync Mumbai from Hyderabad, then switch back in a quiet hour. It's a second migration.

---

## Making it real

- **Everything as code**: the recovery region is built from the same Terraform, so it matches production. See [Terraform Modules](/?topic=terraform-modules&read).
- **Quotas** in the recovery region (vCPUs, Fargate tasks, IPs, RDS instances) raised **before** the day you need them.
- **Images, secrets and config** replicated too: ECR replication, Secrets Manager replica secrets, parameters in both regions.
- **Game days**: fail over for real, at least twice a year, and time it. AWS **Fault Injection Service** can stop instances or block an AZ on purpose; **Resilience Hub** checks your setup against your RTO and RPO.
- **Watch the replication lag** with an alarm: a replica that's an hour behind is a one-hour RPO, whatever the diagram says.

---

## How to choose

```text
Hours of downtime and hours of data loss are acceptable?   → backup and restore (copy backups to another region and account)
Minutes to an hour down, seconds of data loss?            → pilot light
About ten minutes down, seconds of data loss?             → warm standby
Seconds down, ~zero data loss, budget for 2 regions?      → active/active with a global database
Only worried about a data centre failing?                 → Multi-AZ is enough: that's HA, not DR
Worried about bugs, deletes, ransomware?                  → PITR + versioning + cross-account, locked backups (whatever the strategy)
```

---

## ⚠️ Critical Mistakes

- Treating **Multi-AZ as disaster recovery**: it doesn't survive the region, a bad deploy, or a deleted table.
- Treating **replicas as backups**: they replicate the delete in seconds.
- Backups only in the **same region** (unusable during a regional outage) or the **same account** (deletable by whoever stole the keys).
- **Never testing**: the first failover is during the disaster, and the runbook is out of date.
- RTO and RPO **nobody agreed with the business**, so every system gets the most expensive (or cheapest) option.
- The recovery region missing **quotas, images, secrets or certificates**.
- **High DNS TTLs** on records that move: clients keep going to the dead region for an hour.
- **Automatic failover with no human check** on flaky health checks: flapping between regions is its own outage.
- Recovery steps that call **control-plane APIs** in the failing region.
- No plan to **fail back**, or to reconcile writes lost in async replication.
- Not monitoring **replication lag**.

---

## Interview Q&As

**Q: What's the difference between RTO and RPO?**

A: RTO is how long you can be down: the time from the disaster until users are served again. RPO is how much data you can lose, measured as time: with nightly backups the RPO is up to a day; with a replica a few seconds behind, a few seconds.

**Q: What are AWS's four DR strategies, and how do you pick one?**

A: Backup and restore (rebuild from code and backups: hours, cheapest), pilot light (data replicated, compute off: tens of minutes), warm standby (a small working copy that scales up: minutes) and multi-site active/active (both regions serve: seconds, roughly double the cost). Pick the cheapest that meets the RTO and RPO the business agreed for that system.

**Q: Is Multi-AZ a disaster recovery strategy?**

A: No, it's high availability. It survives a server or a data centre failing within the region, with automatic failover in a minute or two. It doesn't help if the region is down, and it copies data corruption and deletes to the standby instantly.

**Q: A bug deletes the orders table. Your replica in Hyderabad is 5 seconds behind. Are you safe?**

A: No: the replica deleted the table five seconds later. You need point-in-time recovery: restore the database to just before the delete (as a new instance), point the app at it, and reconcile anything written between the restore point and now. This is why backups exist alongside replicas.

**Q: How do you move users to the other region?**

A: DNS: Route 53 failover (or latency) routing with health checks on each region's endpoint, alias records to the load balancers and low TTLs. For a deliberate, human-controlled switch, Application Recovery Controller's routing controls. Then promote the data and scale up the recovery region's app.

**Q: How do you protect backups from ransomware or a stolen admin key?**

A: Copy them to a separate account (and region) the attacker can't reach, and lock them: AWS Backup Vault Lock in compliance mode, S3 Object Lock, so even the root user can't delete them before they expire. Versioning on S3 buckets so overwrites and deletes can be undone.

**Q: What's the hardest part of active/active?**

A: Data. Both regions take writes, so you need a database that replicates both ways (DynamoDB global tables, Aurora Global Database with write forwarding, or partitioning users by region) and a plan for conflicts. The app must also be safe to run in two places at once: idempotent payments, no region-local state, jobs that don't run twice.

**Q: How do you know your DR plan works?**

A: Test it: scheduled game days where you actually fail over, timed against the RTO and RPO; fault injection; alarms on replication lag and backup jobs; and regular restore tests, because a backup you've never restored is a hope, not a backup.

---

## Related topics

- [AWS Basics](/?topic=aws-basics&read): regions and Availability Zones
- [Scaling to Millions of Users on AWS](/?topic=scaling-aws&read): the stack being recovered
- [Terraform Modules](/?topic=terraform-modules&read): building the recovery region from the same code
- [Redis Persistence](/?topic=redis-persistence&read): RDB, AOF and failover for the cache tier
- [Kafka Reliability](/?topic=kafka-reliability&read): not losing events when things fail

---

## Sources

- [Disaster recovery options in the cloud (AWS whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [Restoring a DB instance to a specified time](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html)
- [Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [AWS Backup Vault Lock](https://docs.aws.amazon.com/aws-backup/latest/devguide/vault-lock.html)
- [Route 53 DNS failover](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover.html)
- [Static stability using Availability Zones (Amazon Builders' Library)](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/)

---

## Why This Matters

✅ "How would this survive a region failure?" closes many design interviews: RTO, RPO and the four strategies give you a structured answer with costs.

✅ "Replicas aren't backups" and "Multi-AZ isn't DR" are short, correct and catch most candidates out.

✅ Cross-account, locked backups and regular game days are what actually save a company on its worst day.
