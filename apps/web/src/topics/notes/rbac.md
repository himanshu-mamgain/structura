# Role-Based Access Control (RBAC)

> 💡 **TL;DR**: Every app must answer two questions. **Authentication** asks "who are you?" and happens at login; if it fails, the answer is **401**. **Authorization** asks "what may you do?" and happens on every request; if it fails, the answer is **403**. **Role-based access control (RBAC)** answers the second question by giving permissions to **roles** (like accountant or viewer) and roles to **users**, instead of giving permissions to each person. After login, the user gets a short-lived, signed **token** that carries their roles; a gateway checks the token and the permission on every request, refuses anything not granted (**deny by default**), and writes every decision to an **audit log**.

## At a glance

| Question | Answer |
|---|---|
| Authentication | Who are you? Checked at login. Failure: 401 Unauthorized |
| Authorization | What may you do? Checked on every request. Failure: 403 Forbidden |
| A permission | One action on one kind of thing, written `resource:action`, like `invoice:approve` |
| A role | A named set of permissions, like accountant |
| A user | Has one or more roles; can do whatever any of their roles allows |
| Where roles travel | Inside a signed token, a JWT (JSON Web Token), that the app sends with each request |
| Token lifetime | Short: 5 to 15 minutes, renewed with a refresh token |
| Default answer | Deny: anything not granted is refused |
| Fine-grained rules ("only your own drafts") | Checked inside the service, which has the data |
| Record of decisions | An append-only audit log: who, what, when, allowed or refused |

## What authentication, authorization and RBAC are

**Authentication** proves who someone is, usually with a password, a one-time code or a sign-in with Google or GitHub. It happens once, at login.

**Authorization** decides what that person may do, and it happens on every request: may Asha approve this invoice? May Ravi delete that user?

You could store, for every user, a list of everything they may do. With 3 users that's fine. With 3k users and 40 actions, it's 120k grants to keep right, and every new hire means copying someone else's list by hand.

**Role-based access control (RBAC)** groups permissions into **roles** instead. You define a few roles once (accountant, approver, viewer, admin), give each its permissions, and then give each user the roles that match their job. A new accountant gets one role, not 25 separate grants. Removing someone's access is removing a role.

## The model: users, roles, permissions

- A **permission** is one action on one kind of resource, written `resource:action`: `invoice:read`, `invoice:approve`, `user:delete`. These names are easy to read, check and search in logs.
- A **role** is a named set of permissions.
- A **user** has one or more roles. What they may do is everything any of their roles allows.

Here's a small invoicing app:

| Role | Permissions |
|---|---|
| viewer | `invoice:read` |
| accountant | `invoice:read`, `invoice:create`, `invoice:edit` |
| approver | `invoice:read`, `invoice:approve` |
| admin | everything, including `user:manage` |

| User | Roles | So they may |
|---|---|---|
| Asha | accountant | read, create and edit invoices |
| Ravi | accountant, approver | also approve |
| Meera | viewer | only read |

Both links are many-to-many: a user can have many roles and a role many users; a role has many permissions and a permission can be in many roles. So the database has two **join tables** (tables that only link two other tables):

```sql
CREATE TABLE user_roles       (user_id BIGINT, role_id BIGINT, PRIMARY KEY (user_id, role_id));
CREATE TABLE role_permissions (role_id BIGINT, permission TEXT, PRIMARY KEY (role_id, permission));

-- Everything Ravi may do:
SELECT DISTINCT rp.permission
FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
WHERE ur.user_id = 42;
```

Two rules keep it safe:
- **Deny by default**: if no role grants a permission, the answer is no.
- **Least privilege**: give each role only what the job needs. Not everyone needs admin.

## Follow one request all the way through

On 25 November 2026 at 10:00 India time (04:30 UTC), Meera, a viewer, signs in and then tries to approve invoice 881.

| Step | What happens | Box in the diagram |
|---|---|---|
| 1 | Meera types her password; the app sends it to the Login Service | User → Client App → Login Service |
| 2 | The Login Service checks it against the stored password hash and loads her roles: `["viewer"]` | Users & Roles DB |
| 3 | It signs a token with her id and roles, valid for 15 minutes | Issue JWT (roles claim) |
| 4 | The app calls `POST /invoices/881/approve` with the token in the `Authorization` header | Client App → API Gateway |
| 5 | The gateway checks the token's signature and that it hasn't expired: fine | Token valid? |
| 6 | The route needs `invoice:approve`; the viewer role only has `invoice:read` | Policy Check |
| 7 | No role grants it, so the answer is **403 Forbidden** | Has permission? → 403 Forbidden |
| 8 | The refusal is written to the audit log | Audit Log |

If her token had been forged or expired, the gateway would have stopped at step 5 with **401 Unauthorized**, before even looking at permissions.

## Roles travel in a signed token

Asking the database for the user's roles on every request would put a query in front of every call. Instead, at login the Login Service puts the roles in a **JWT**: a small piece of JSON, signed with the server's private key so nobody can change it without the signature breaking.

Meera's token carries this:

```json
{
  "sub": "user_1081",
  "roles": ["viewer"],
  "iat": 1795581000,
  "exp": 1795581900
}
```

- `sub` (subject) is who the token is about.
- `roles` is what the gateway checks.
- `iat` (issued at) and `exp` (expires) are seconds since 1 January 1970: 1795581000 is 04:30 UTC on 25 November 2026, and `exp` is 900 seconds (15 minutes) later, 04:45 UTC.

The app sends it on every request:

```http
POST /invoices/881/approve HTTP/1.1
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEwODEi...
```

Any service can check the signature with the server's **public key**, published as a JWKS (JSON Web Key Set), so the gateway never has to call the Login Service.

### The catch: changes wait for expiry

The roles inside a token can't change until it expires. If you remove Ravi's approver role at 10:05, a token he got at 10:00 still says approver until 10:15. That's why access tokens are short (5 to 15 minutes): the app quietly gets a new one with a longer-lived **refresh token**, and the new one carries the current roles.

For urgent cases, like someone leaving the company, keep a short **denylist** of revoked token ids, checked on every request, until those tokens expire.

## Checking permissions in code

The gateway maps each route to the permission it needs, and checks the token's roles against a cached role → permissions table. Roles change rarely, so this table lives in memory.

```javascript
const ROLE_PERMISSIONS = {
  viewer: ['invoice:read'],
  accountant: ['invoice:read', 'invoice:create', 'invoice:edit'],
  approver: ['invoice:read', 'invoice:approve'],
}

function can(roles, permission) {
  return roles.some((role) => (ROLE_PERMISSIONS[role] ?? []).includes(permission))
}

function authorize(token, permission) {
  if (!token || token.exp * 1000 < Date.now()) return 401 // not signed in, or expired
  if (!can(token.roles, permission)) return 403 // signed in, not allowed
  return 200
}

authorize({ roles: ['viewer'], exp: 1795581900 }, 'invoice:approve') // 403 (while the token is valid)
```

`(ROLE_PERMISSIONS[role] ?? [])` treats an unknown role as having no permissions: deny by default. (In a real gateway the signature is checked first; this only shows the order of the two decisions.)

## Where to enforce what

- **Coarse rules** ("only approvers may call `POST /invoices/:id/approve`") fit in the gateway, once, so every service doesn't re-implement them.
- **Fine rules** ("accountants may edit only invoices they created") need data the gateway doesn't have: who created invoice 881. The service checks those itself, after the gateway.

When many rules depend on attributes like owner, department or time of day, plain RBAC gets awkward. **ABAC** (attribute-based access control) decides from attributes instead of roles, and relationship-based systems such as Google's Zanzibar decide from links like "Ravi is an editor of this folder". Most real systems use RBAC plus a few such checks.

## The audit log

Every decision, allowed or refused, is appended to the **Audit Log**: who, which action on which resource, when, and the result. It answers "who approved this invoice?", spots someone probing for access they don't have, and most compliance standards require it. Append-only means entries are never edited or deleted.

## What it costs and where it stops

- **Role explosion**: creating a new role for every small difference ("accountant-but-can-also-export") ends up as hard to manage as per-user grants. Start with a few broad roles.
- **Token delay**: role changes take effect only when the token expires; keep tokens short and keep a denylist for emergencies.
- **Login service outage**: existing tokens keep working until they expire, but nobody new can sign in. Run it on several servers.
- **Key rotation**: signing keys must be replaced now and then. Publish the public keys so services pick up new ones without a redeploy.
- **Fail closed**: if a permission check can't finish (the role table didn't load), refuse the request rather than allow it.

## How to choose

- **A handful of job types, each doing similar things?** Plain RBAC.
- **Rules about ownership** ("your own drafts")? RBAC for the coarse rule, plus a check in the service.
- **Rules from many attributes** (region, department, time)? Add ABAC for those routes.
- **Sharing like Google Drive** (people, groups, folders)? A relationship-based system.
- **Roles in the token or looked up every time?** In the token, with short lifetimes, for speed; look up every time only if changes must apply instantly.

## ⚠️ Critical Mistakes

- **Mixing up 401 and 403.** 401 means "we don't know who you are"; 403 means "we know, and you may not".
- **Giving permissions to users directly.** It works at first and becomes unmanageable. Grant to roles.
- **Allow by default.** A missing rule must mean no.
- **Long-lived tokens.** A token that lasts a week keeps a removed role working for a week.
- **Checking only in the browser.** Hiding a button isn't security; the server must check every request.
- **Only checking at the gateway.** It can't know who owns a record. Services must check ownership themselves.
- **Not logging refusals.** Refusals are how you spot attacks.

## Interview Q&As

**Q: What's the difference between authentication and authorization?**

A: Authentication proves who you are, once, at login; failure is 401 Unauthorized. Authorization decides what you may do, on every request; failure is 403 Forbidden. RBAC is a way to do authorization.

**Q: A user's role is removed. How quickly does it take effect, and how do you make it immediate?**

A: With roles in a token, at the token's expiry, so keep access tokens to 5 to 15 minutes. To make it immediate, put the token's id on a denylist checked on every request until it expires, or look roles up on every request for sensitive actions.

**Q: How would you let editors edit only their own articles?**

A: RBAC gives editors `article:edit`. The service then also checks that the article's author is the caller, because only the service has that data. That second check is attribute-based.

**Q: How do role hierarchies work, where admin has everything editor has?**

A: Let a role include other roles: admin includes editor, editor includes viewer. When building a user's permissions, collect them from each role and every role it includes, and cache the result per role.

## Related topics

- [API Gateway](/?topic=api-gateway&read): where tokens and coarse permissions are checked once for every service.
- [AWS IAM](/?topic=aws-iam&read): the same ideas, policies and roles, for cloud resources.
- [Rate Limiter](/?topic=rate-limiter&read): the other check that usually happens at the gateway.
- [Idempotent Payments](/?topic=payment-idempotency&read): what happens after the request is allowed and money moves.

## Sources

- NIST: [Role Based Access Control](https://csrc.nist.gov/projects/role-based-access-control)
- IETF: [RFC 7519, JSON Web Token (JWT)](https://www.rfc-editor.org/rfc/rfc7519)
- IETF: [RFC 9110, HTTP Semantics: 401 Unauthorized](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2) and [403 Forbidden](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.4)
- OWASP: [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)

## Why This Matters

Almost every product needs permissions, and getting them wrong is one of the most common security bugs: a user seeing another user's data, or a removed employee keeping access. Interviewers ask about RBAC to see whether you separate "who are you" from "what may you do", know why tokens are short-lived, and know which checks belong at the edge and which only the service can make.
