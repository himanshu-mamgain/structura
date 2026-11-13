# AWS IAM: Users, Roles, Policies, STS, Boundaries and SCPs

> 💡 **TL;DR**: Every AWS API call is **signed by an identity** and checked by IAM. People sign in through **IAM Identity Center** (or IAM users) with MFA; software uses **roles**, which hand out **temporary credentials** from STS, so there are no keys to leak. Permissions are JSON **policies**: Effect, Action, Resource, Condition. AWS gathers every policy that applies and decides: **an explicit Deny anywhere wins**, then every guardrail that applies (SCPs, permissions boundaries, session policies) must allow, and without an Allow the answer is **no**. Grant the least you can, put the things that must never happen in Denies, and use boundaries and SCPs so nobody can hand out more than they have.

Builds on [AWS Basics](/?topic=aws-basics&read). Every other AWS topic uses roles from here: ECS task roles, deploy roles, cross-account access.

---

## IAM at a glance

| Term | What it is | Example |
| --- | --- | --- |
| Root user | The account owner (sign-up email); can do anything, including close the account | Lock it with MFA; use it almost never |
| IAM user | A long-lived identity with a password and/or access keys | Avoid for people (use Identity Center) and for software (use roles) |
| Group | A set of IAM users sharing policies | `Developers` |
| Role | An identity with no credentials of its own; whoever is trusted to assume it gets temporary ones | `orders-task-role`, `deploy-role` |
| Policy | JSON that allows or denies actions on resources | `OrdersTaskPolicy` |
| Principal | Who is making the request | `arn:aws:iam::111122223333:role/deploy-role` |
| ARN | Amazon Resource Name: the unique id of anything | `arn:aws:s3:::priya-menu-photos/menus/*` |
| STS | Security Token Service: issues temporary credentials | `AssumeRole`, `AssumeRoleWithWebIdentity` |
| IAM Identity Center | Single sign-on for people across many accounts | `aws configure sso` |
| Organizations / SCP | Many accounts managed together; guardrail policies over whole accounts | "Nobody works outside Mumbai" |
| CloudTrail | The log of every API call, allowed or denied | Who deleted that bucket? |

ARN format: `arn:partition:service:region:account-id:resource`. Some services leave parts empty: S3 buckets have no region or account (`arn:aws:s3:::bucket/key`), and IAM has no region (`arn:aws:iam::111122223333:role/x`).

---

## Anatomy of a policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteOrders",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:ap-south-1:111122223333:table/Orders"
    },
    {
      "Sid": "ManageDevServersOnly",
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:ResourceTag/env": "dev" } }
    }
  ]
}
```

| Element | Means | Notes |
| --- | --- | --- |
| `Version` | The policy language version | Always `2012-10-17`; older versions don't support variables |
| `Sid` | A label for the statement | Optional; shows up when you debug |
| `Effect` | `Allow` or `Deny` | |
| `Action` / `NotAction` | API calls, `service:Operation`, wildcards allowed | `NotAction` means "every action except these" |
| `Resource` / `NotResource` | ARNs the statement covers | `*` means all; some actions only work with `*` |
| `Principal` | Who the statement applies to | Only in resource-based and trust policies |
| `Condition` | Extra tests on the request | MFA, tags, IP, region, VPC endpoint, time |

Wildcards match within an ARN or action: `s3:Get*` covers `GetObject` and `GetBucketPolicy`; `arn:aws:s3:::priya-menu-photos/*` covers every object but **not the bucket itself**, which is why read policies list both `bucket` and `bucket/*`.

---

## The kinds of policy

| Type | Attached to | Grants? | Use for |
| --- | --- | --- | --- |
| **Identity-based** (managed or inline) | Users, groups, roles | Yes | What this person or service may do |
| **Resource-based** | A resource: S3 bucket, SQS queue, KMS key, Lambda | Yes, to the principals it names | Sharing with other accounts and services; "never delete this bucket" |
| **Trust policy** | A role (it's a resource policy) | Who may **assume** the role | The service, account or CI provider allowed in |
| **Permissions boundary** | A user or role | No: sets the most it can ever do | Letting teams or pipelines create roles safely |
| **Service control policy (SCP)** | An account or OU in Organizations | No: caps every identity in the account | Company-wide guardrails: regions, no leaving the org |
| **Resource control policy (RCP)** | An account or OU in Organizations | No: caps access to the account's resources | "Our buckets are never readable from outside the org" |
| **Session policy** | Passed when assuming a role | No: narrows that one session | Handing a job a slice of a role's power |

**Managed** policies are standalone and reusable (AWS-managed like `ReadOnlyAccess`, or your own). **Inline** policies live inside one user or role and die with it. Prefer your own managed policies: they're versioned and reusable.

---

## How AWS decides: policy evaluation

```text
Request: who (principal) wants to do what (action) to which resource, with what context
   │
   ├─ 1. Any explicit Deny in ANY applicable policy?              → DENY (nothing overrides it)
   ├─ 2. SCPs (and RCPs) on the account: do they allow it?          → if not: DENY
   ├─ 3. A resource-based policy in the same account allows it
   │     for this principal?                                        → can ALLOW on its own*
   ├─ 4. An identity-based policy allows it?                        → if not: DENY (implicit)
   ├─ 5. A permissions boundary on the principal allows it?         → if not: DENY
   └─ 6. A session policy (if the session has one) allows it?       → if not: DENY
                                                                    → ALLOW
* For an IAM user it's enough; for a role, the role's boundary and session policy still cap it.
```

- **Default deny**: nothing is allowed until something allows it.
- **Explicit Deny beats any Allow**, wherever each one is.
- Guardrails (SCPs, RCPs, boundaries, session policies) **only take away**: they never grant. The effective permissions are the **intersection**.
- **Cross-account** requests need **both sides**: the other account's resource policy (or role trust policy) must allow you, and your own identity policy must allow the call.

Worked example (from the topic's simulator): the deploy role has `AdministratorAccess`, but its boundary only allows ECS, ECR, EC2, Auto Scaling, load balancers, two S3 actions and `iam:PassRole` for one role. It calls `iam:CreateUser`. The identity policy allows it, the boundary doesn't, so the result is **implicit deny**: an admin that can't make admins.

---

## Roles and temporary credentials

A role has two policies: the **trust policy** (who may assume it) and **permissions policies** (what it can do once assumed). Assuming it returns three values, an access key id, a secret and a **session token**, which expire after 1 hour by default (the role can allow 1 to 12 hours; a role assumed from another role's session gets at most 1 hour).

Where software gets its role, so nobody writes a key anywhere:

| Runs on | Role is | The SDK finds credentials at |
| --- | --- | --- |
| EC2 | An **instance profile** | The instance metadata service (IMDSv2) |
| ECS task | The **task role** (your app's permissions) | The container credentials endpoint |
| ECS agent | The **task execution role** (pull the image, write logs, read secrets at start) | Used by ECS, not your code |
| Lambda | The **execution role** | Environment variables set by Lambda |
| GitHub Actions, GitLab CI | A role trusted through **OIDC** | `AssumeRoleWithWebIdentity` with the CI's signed token |
| Your laptop | A permission set in **IAM Identity Center** | `aws configure sso` → short-lived credentials |

### CI without stored keys: GitHub Actions with OIDC

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:priya-foods/orders-api:ref:refs/heads/main" }
      }
    }
  ]
}
```

```yaml
# .github/workflows/deploy.yml
permissions:
  id-token: write   # lets the job ask GitHub for a signed OIDC token
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::111122223333:role/deploy-role
      aws-region: ap-south-1
  - run: aws ecs update-service --cluster prod --service orders-api --force-new-deployment
```

The `sub` condition is what matters: without it, **any** GitHub repository could assume your role.

### Assuming a role from code

```javascript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

// Read a report from another account. The SDK calls sts:AssumeRole for us and
// refreshes the credentials before they expire.
const reports = new S3Client({
  region: 'ap-south-1',
  credentials: fromTemporaryCredentials({
    params: {
      RoleArn: 'arn:aws:iam::444455556666:role/reports-reader',
      RoleSessionName: 'orders-api-nightly-report',   // shows up in the other account's CloudTrail
      DurationSeconds: 900,                           // 15 minutes: the minimum
    },
  }),
});

await reports.send(new GetObjectCommand({ Bucket: 'finance-reports', Key: '2026/11/settlements.csv' }));
```

---

## Conditions: tightening an Allow

| Condition key | Checks | Typical use |
| --- | --- | --- |
| `aws:MultiFactorAuthPresent` | The caller signed in with MFA | Deny sensitive actions without MFA |
| `aws:RequestedRegion` | The region the call goes to | Keep everyone in Mumbai |
| `aws:PrincipalTag/…`, `aws:ResourceTag/…` | Tags on the caller and the resource | ABAC: "team=payments may touch team=payments" |
| `aws:SourceIp` | The caller's public IP | Office-only console access |
| `aws:SourceVpce`, `aws:SourceVpc` | The call came through your VPC endpoint | Bucket readable only from inside your network |
| `aws:PrincipalOrgID` | The caller belongs to your Organization | Share with every account in the org at once |
| `aws:SecureTransport` | The request used HTTPS | Deny plain HTTP to a bucket |
| `s3:prefix` | The folder being listed | Each user lists only `home/<name>/` |

Operators: `StringEquals`, `StringLike` (wildcards), `ArnLike`, `Bool`, `IpAddress`, `NumericLessThan`, `DateGreaterThan`, and `…IfExists` for keys that may be missing. Several keys in one condition are ANDed; several values for one key are ORed.

> ⚠️ A Deny with `"Bool": {"aws:MultiFactorAuthPresent": "false"}` does **not** match when the key is missing, and long-term access keys don't send it. Use `BoolIfExists` so keys without MFA are denied too, and attach that Deny to people, not to service roles: an ECS task or a Lambda function never signs in with MFA, so the same Deny would block everything it does.

**ABAC** (attribute-based access control) scales better than one policy per team: tag users and resources, and write one policy.

```json
{
  "Effect": "Allow",
  "Action": ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances"],
  "Resource": "*",
  "Condition": { "StringEquals": { "aws:ResourceTag/team": "${aws:PrincipalTag/team}" } }
}
```

---

## Permissions boundaries: delegating safely

You want the platform team's pipeline to create roles for new services, but not a role more powerful than the pipeline. A **boundary** caps what any role it creates can do, and the pipeline may only create roles that carry it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CreateAppRolesOnlyWithTheBoundary",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:AttachRolePolicy", "iam:PutRolePolicy"],
      "Resource": "arn:aws:iam::111122223333:role/app-*",
      "Condition": { "StringEquals": { "iam:PermissionsBoundary": "arn:aws:iam::111122223333:policy/AppBoundary" } }
    },
    {
      "Sid": "NeverRemoveOrEditTheBoundary",
      "Effect": "Deny",
      "Action": ["iam:DeleteRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"],
      "Resource": ["arn:aws:iam::111122223333:policy/AppBoundary", "arn:aws:iam::111122223333:role/app-*"]
    }
  ]
}
```

Also limit `iam:PassRole`: it's what lets someone give a role to EC2, ECS or Lambda. `iam:PassRole` on `*` plus `ec2:RunInstances` is a way to run code as any role in the account.

---

## Organizations and SCPs: guardrails for whole accounts

Big setups use **many accounts** (per environment, per team) in an AWS Organization: a mistake or breach in `dev` can't touch `prod`. **SCPs** apply to every identity in an account, **including its root user and admins** (but never to the organization's management account).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyOutsideIndia",
      "Effect": "Deny",
      "NotAction": ["iam:*", "sts:*", "organizations:*", "cloudfront:*", "route53:*", "support:*", "budgets:*"],
      "Resource": "*",
      "Condition": { "StringNotEquals": { "aws:RequestedRegion": ["ap-south-1", "ap-south-2"] } }
    },
    {
      "Sid": "NoTurningOffTheAuditLog",
      "Effect": "Deny",
      "Action": ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail"],
      "Resource": "*"
    }
  ]
}
```

The `NotAction` list exempts global services, whose calls go to `us-east-1` whatever region you work in. Without it, the region rule would block IAM and Route 53.

---

## Debugging AccessDenied

1. **Who am I?** `aws sts get-caller-identity`: often the wrong profile or role.
2. **Read the error.** It names the action and resource, and usually which **kind** of policy denied it ("…with an explicit deny in a service control policy", "…because no identity-based policy allows…").
3. **Find the call in CloudTrail** (`errorCode: AccessDenied`) to see the exact principal, action, resource and region.
4. **Simulate** with `aws iam simulate-principal-policy`, or the policy simulator in the console.
5. **Check the other layers**: SCPs, the permissions boundary, the bucket or key policy, and the region (an SCP may block it).
6. **KMS**: reading an encrypted object needs `kms:Decrypt` on the key **and** the key policy has to allow it. "S3 says access denied" is often really KMS.

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::111122223333:role/deploy-role \
  --action-names ecs:UpdateService iam:CreateUser \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
# ecs:UpdateService   allowed
# iam:CreateUser      implicitDeny
```

---

## Least privilege in practice

1. Start from **nothing**, or from a narrow AWS-managed policy while you explore.
2. Name **specific actions and ARNs**; avoid `service:*` and `Resource: "*"` except where an action requires `*`.
3. Let AWS help: **IAM Access Analyzer** can generate a policy from the calls a role actually made in CloudTrail, flags resources shared outside your account, and reports **unused** roles, keys and permissions.
4. Review **last accessed** data on roles and remove services they never use.
5. Put the things that must **never** happen in explicit **Denies** (SCPs or resource policies): deleting backups, disabling CloudTrail, leaving the region.

---

## How to choose

```text
A person signing in?                             → IAM Identity Center + MFA (IAM user + MFA if you can't)
Software running on AWS?                         → a role: instance profile, task role, execution role
CI/CD outside AWS?                               → OIDC trust to a role; no stored keys
Another AWS account needs access?                → a role they assume, or a resource policy + their identity policy
Rules every account must follow?                 → SCP (on identities) or RCP (on resources)
Let someone create roles without escalating?     → permissions boundary + conditions on iam:CreateRole
Many teams, same pattern?                        → ABAC with tags instead of one policy per team
```

---

## ⚠️ Critical Mistakes

- Using the **root user** day to day, or leaving it without MFA.
- **Access keys** for software, in `.env` files, code or CI secrets: use roles and OIDC. Bots scan public repos for keys within minutes.
- `"Action": "*", "Resource": "*"` for an app "to get it working", and never trimming it.
- `iam:PassRole` on `*`: lets someone run code as any role in the account.
- A GitHub OIDC trust policy **without a `sub` condition**: any repository can assume the role.
- A trust policy with `"Principal": {"AWS": "*"}` and no condition: anyone in any account can assume it.
- Forgetting the bucket ARN vs `bucket/*`: `s3:ListBucket` needs the bucket, `s3:GetObject` needs the objects.
- `Bool` instead of `BoolIfExists` in an MFA Deny: keys without MFA slip through.
- A region-restricting SCP **without exempting global services**: IAM and Route 53 break.
- Sharing one IAM user between people: CloudTrail can't tell who did what.
- Giving the ECS **task execution role** your app's permissions (or the other way round): they are two roles for two jobs.
- Debugging access denied by attaching `AdministratorAccess` "for now".

---

## Interview Q&As

**Q: What's the difference between an IAM user and a role?**

A: A user is a long-lived identity with its own password or access keys. A role has no credentials of its own: whoever its trust policy allows (a service, another account, a federated user, CI through OIDC) assumes it and gets temporary credentials from STS that expire, by default after an hour. Software and people should use roles; IAM users are mostly a legacy option.

**Q: Why are temporary credentials safer than access keys?**

A: They expire on their own (minutes to hours), are issued per session, and are never written into code or config. A leaked access key works until someone notices and deletes it; a leaked session token stops working soon after.

**Q: Walk through how AWS evaluates a request with an Allow in one policy and a Deny in another.**

A: Deny wins. AWS collects every policy that applies: identity, resource, boundary, SCP, session. If any of them has an explicit Deny that matches, the request is denied, whatever the Allows say. Otherwise every guardrail that applies must allow it, and an identity or resource policy must actually grant it. No matching Allow means an implicit deny.

**Q: What does a permissions boundary do that a smaller policy doesn't?**

A: A boundary doesn't grant anything; it caps the most a user or role can ever be allowed, whatever policies get attached later. That's what makes delegation safe: you can let a team or pipeline create and edit roles, on condition that every role it creates carries the boundary, so nothing it creates can exceed it.

**Q: How does an SCP differ from an IAM policy?**

A: An SCP is attached to an account or organizational unit and limits every identity in it, including the root user and admins. It never grants anything: something in the account still has to allow the action. IAM policies are attached to identities or resources and do grant. Use SCPs for company-wide rules like allowed regions or "never disable CloudTrail".

**Q: How do two AWS accounts share access?**

A: Either account B creates a role whose trust policy lets account A's principals assume it, and A's identity policy allows `sts:AssumeRole` on it; or the resource itself (a bucket, a queue, a KMS key) has a resource policy naming A's principals, and A's identity policy allows the action. Both sides must agree.

**Q: How would you give a service in ECS access to one DynamoDB table?**

A: Create a task role with a policy allowing only the needed actions (`dynamodb:GetItem`, `PutItem`, `Query`…) on that table's ARN, trusted by `ecs-tasks.amazonaws.com`, and set it as the task definition's task role. The SDK picks up its temporary credentials from the container endpoint. No keys in the image or environment.

**Q: Someone deleted a production resource. How do you find out who?**

A: CloudTrail: look up the event (`DeleteBucket`, `TerminateInstances`…) by name and time to get the principal (user, or role plus session name), source IP and user agent. Then fix the cause: tighter policies, an explicit Deny or SCP on deletes, and MFA for destructive actions.

**Q: An access key leaked on GitHub. What do you do?**

A: Deactivate the key at once, then check CloudTrail for what it did and clean up (unknown instances, users, roles, keys). Rotate anything it could read, check the bill, and replace the key with a role or OIDC so there is no long-lived key to leak again.

**Q: What is ABAC and when is it better than RBAC?**

A: Attribute-based access control: policies compare tags on the caller with tags on the resource ("you may manage instances whose `team` tag equals your own `team` tag"). One policy covers every team, and new resources are covered as soon as they're tagged. Role-based access needs a new policy per team or project, which grows quickly.

---

## Related topics

- [AWS Basics](/?topic=aws-basics&read): the services these policies protect
- [ECS on Fargate](/?topic=aws-ecs-fargate&read): task roles and execution roles in practice
- [Full-stack App on ECS](/?topic=aws-ecs-fullstack&read): a deploy pipeline with its own role
- [VPC Networking](/?topic=aws-vpc&read): VPC endpoints, which `aws:SourceVpce` conditions point at
- [Role-Based Access Control](/?topic=rbac&read): the same ideas in your own app

---

## Sources

- [IAM policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
- [IAM JSON policy elements](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html)
- [Permissions boundaries for IAM entities](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [Service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [Security best practices in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [Configuring OpenID Connect in Amazon Web Services (GitHub)](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)

---

## Why This Matters

✅ Every AWS design has an IAM question hidden in it: "how does the service reach the table?" is answered with a role, not a key.

✅ "Explicit deny wins, guardrails only take away, both sides must agree across accounts" covers most evaluation questions in one breath.

✅ Roles, OIDC and boundaries are the difference between a leaked key costing you a weekend and it costing you nothing.
