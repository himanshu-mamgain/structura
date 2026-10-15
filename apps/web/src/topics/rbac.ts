import type { Trace } from '@structura/shared'
import { base64url, json, type Simulator } from './simulator'
import type { StaticTopic } from './types'

/** The example's role table: what each role may do. The code snippet uses the same one. */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  viewer: ['article:read'],
  editor: ['article:read', 'article:write'],
  admin: ['article:read', 'article:write', 'article:delete', 'user:manage'],
}

const REQUESTS: Record<string, string> = {
  'article:read': 'GET /articles/42',
  'article:write': 'PUT /articles/42',
  'article:delete': 'DELETE /articles/42',
  'user:manage': 'POST /admin/users',
}

const simulator: Simulator = {
  fields: [
    { id: 'role', label: 'User\'s role', options: Object.keys(ROLE_PERMISSIONS) },
    { id: 'permission', label: 'What they try to do', options: Object.keys(REQUESTS) },
    { id: 'token', label: 'Their token', options: ['valid', 'expired'] },
  ],
  defaults: { role: 'editor', permission: 'article:delete', token: 'valid' },
  run({ role, permission, token }) {
    const granted = ROLE_PERMISSIONS[role] ?? []
    const request = REQUESTS[permission] ?? 'GET /articles/42'
    const issuedAt = 1791711000 // 2026-10-11T09:30:00Z
    const claims = {
      sub: 'u_8f14e45f',
      roles: [role],
      iss: 'https://auth.example.com',
      iat: issuedAt,
      exp: token === 'expired' ? issuedAt - 60 : issuedAt + 15 * 60,
    }
    const jwt = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-2026-10' }))}.${base64url(JSON.stringify(claims))}.SIGNATURE`

    const steps: Trace['steps'] = [
      { text: 'The User signs in through the Client App, which sends the credentials to the Login Service over HTTPS.', nodes: ['User', 'Client App', 'Login Service'], data: `POST /login\n${json({ email: 'maya@example.com', password: '••••••••' })}` },
      { text: 'The Login Service checks the password against the stored bcrypt hash, then loads the user\'s roles.', nodes: ['Login Service', 'Users & Roles DB'], data: `SELECT r.name FROM user_roles ur\nJOIN roles r ON r.id = ur.role_id\nWHERE ur.user_id = 'u_8f14e45f';\n→ ${json([role])}` },
      { text: 'Issue JWT: the roles go into a signed, short-lived token. Anyone can read the claims; only the Identity Provider can sign them.', nodes: ['Issue JWT (roles claim)'], data: `claims = ${json(claims)}\n\ntoken = ${jwt}` },
      { text: `The Client App calls the API with the token. The route needs the permission "${permission}".`, nodes: ['Client App', 'API Gateway'], data: `${request}\nAuthorization: Bearer ${jwt.slice(0, 36)}…` },
    ]

    if (token === 'expired') {
      steps.push({ text: 'Token valid? The signature checks out, but exp is in the past. Authentication failed, so the answer is 401 (not 403): "sign in again".', nodes: ['Token valid?', '401 Unauthorized'], data: `exp ${claims.exp} < now ${issuedAt}\n\nHTTP/1.1 401 Unauthorized\nWWW-Authenticate: Bearer error="invalid_token"\n${json({ error: 'token expired' })}` })
      return { input: `${role} tries ${permission} with an expired token`, steps }
    }

    const allowed = granted.includes(permission)
    steps.push(
      { text: 'Token valid? The gateway verifies the RS256 signature with the public key for kid "key-2026-10" and checks exp. Both pass.', nodes: ['API Gateway', 'Token valid?'], data: `signature ✓ (key-2026-10)\nexp ${claims.exp} > now ${issuedAt} ✓\nroles = ${json([role])}` },
      { text: `Policy Check expands the role into permissions and looks for "${permission}".`, nodes: ['Policy Check'], data: `required: ${permission}\n${role} grants: ${json(granted)}` },
    )
    if (allowed) {
      steps.push(
        { text: `Has permission? Yes, "${role}" includes it, so the request reaches the Protected Service.`, nodes: ['Has permission?', 'Protected Service'], data: `${request} → HTTP/1.1 ${request.startsWith('DELETE') ? '204 No Content' : request.startsWith('POST') ? '201 Created' : '200 OK'}` },
        { text: 'The decision is recorded in the Audit Log.', nodes: ['Audit Log'], data: json({ sub: claims.sub, action: permission, resource: request.split(' ')[1], decision: 'allow', at: '2026-10-11T09:31:12Z' }) },
      )
    } else {
      steps.push(
        { text: `Has permission? No. The user is signed in, but "${role}" does not include "${permission}", so the answer is 403 Forbidden (not 401: signing in again would not help).`, nodes: ['Has permission?', '403 Forbidden'], data: `HTTP/1.1 403 Forbidden\n${json({ error: `missing permission ${permission}` })}` },
        { text: 'Refusals are audited too: they are how you spot misconfigured roles or someone probing the API.', nodes: ['Audit Log'], data: json({ sub: claims.sub, action: permission, resource: request.split(' ')[1], decision: 'deny', at: '2026-10-11T09:31:12Z' }) },
      )
    }
    return { input: `${role} tries ${permission}`, steps }
  },
}

const roleTable = Object.entries(ROLE_PERMISSIONS)
  .map(([role, permissions]) => `  ${role}: [${permissions.map((p) => `'${p}'`).join(', ')}],`)
  .join('\n')

export const rbac: StaticTopic = {
  difficulty: 'Beginner',
  kind: 'static',
  id: 'rbac',
  title: 'Role-Based Access Control (RBAC)',
  blurb: 'Authentication vs authorization, roles, permissions, JWT claims',
  video: '/videos/rbac.mp4',
  chapters: [
    [0, "Introduction"],
    [4, "401 vs 403"],
    [23, "Users, roles, permissions"],
    [39, "Following a request"],
    [72, "When access is refused"],
    [90, "Recap"],
  ],
  guides: [
    "primer-security",
    "jwt-101-key-to-stateless-authentication",
    "what's-the-difference-between-session-based-authentication-and-jwts",
    "oauth-2-explained-with-siple-terms",
    "top-4-forms-of-authentication-mechanisms",
    "how-to-design-secure-web-api-access-for-your-website",
  ],
  takeaways: [
    "Authentication asks who you are (401); authorization asks what you may do (403).",
    "Grant permissions to roles and roles to users, never permissions to users directly.",
    "Deny by default, and give each role only what it needs.",
    "Short-lived JWTs carry roles; a removed role stops working when the token expires.",
    "Check coarse rules at the gateway and ownership rules in the service.",
    "Audit every decision, refusals included.",
  ],
  architecture: {
    replace: false,
    direction: 'right',
    groups: [
      { id: 'idp', label: 'Identity Provider' },
      { id: 'api', label: 'API layer' },
    ],
    nodes: [
      { id: 'user', label: 'User', shape: 'ellipse', color: 'blue', group: null },
      { id: 'app', label: 'Client App', shape: 'rectangle', color: 'blue', group: null },
      { id: 'login', label: 'Login Service', shape: 'rectangle', color: 'violet', group: 'idp' },
      { id: 'userdb', label: 'Users & Roles DB', shape: 'rectangle', color: 'green', group: 'idp' },
      { id: 'issue', label: 'Issue JWT (roles claim)', shape: 'rectangle', color: 'violet', group: 'idp' },
      { id: 'gateway', label: 'API Gateway', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'valid', label: 'Token valid?', shape: 'diamond', color: 'violet', group: 'api' },
      { id: 'policy', label: 'Policy Check', shape: 'rectangle', color: 'violet', group: 'api' },
      { id: 'allowed', label: 'Has permission?', shape: 'diamond', color: 'violet', group: 'api' },
      { id: 'service', label: 'Protected Service', shape: 'rectangle', color: 'violet', group: null },
      { id: 'unauth', label: '401 Unauthorized', shape: 'rectangle', color: 'red', group: null },
      { id: 'forbidden', label: '403 Forbidden', shape: 'rectangle', color: 'red', group: null },
      { id: 'audit', label: 'Audit Log', shape: 'rectangle', color: 'green', group: null },
    ],
    edges: [
      { from: 'user', to: 'app', label: 'signs in', dashed: false },
      { from: 'app', to: 'login', label: 'credentials', dashed: false },
      { from: 'login', to: 'userdb', label: 'verify, load roles', dashed: false },
      { from: 'login', to: 'issue', label: 'roles', dashed: false },
      { from: 'issue', to: 'app', label: 'signed JWT', dashed: true },
      { from: 'app', to: 'gateway', label: 'request + Bearer JWT', dashed: false },
      { from: 'gateway', to: 'valid', label: 'check signature, expiry', dashed: false },
      { from: 'valid', to: 'unauth', label: 'no', dashed: true },
      { from: 'valid', to: 'policy', label: 'yes', dashed: false },
      { from: 'policy', to: 'allowed', label: 'role → permissions', dashed: false },
      { from: 'allowed', to: 'service', label: 'yes', dashed: false },
      { from: 'allowed', to: 'forbidden', label: 'no', dashed: true },
      { from: 'policy', to: 'audit', label: 'log decision', dashed: true },
    ],
  },
  database: {
    replace: false,
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [
          { name: 'id', type: 'uuid', pk: true, fk: null, nullable: false, unique: false },
          { name: 'email', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'password_hash', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'created_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'roles',
        name: 'roles',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'name', type: 'text', pk: false, fk: null, nullable: false, unique: true },
          { name: 'description', type: 'text', pk: false, fk: null, nullable: true, unique: false },
        ],
        indexes: [],
      },
      {
        id: 'permissions',
        name: 'permissions',
        columns: [
          { name: 'id', type: 'bigint', pk: true, fk: null, nullable: false, unique: false },
          { name: 'resource', type: 'text', pk: false, fk: null, nullable: false, unique: false },
          { name: 'action', type: 'text', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['unique (resource, action)'],
      },
      {
        id: 'user_roles',
        name: 'user_roles',
        columns: [
          { name: 'user_id', type: 'uuid', pk: true, fk: 'users.id', nullable: false, unique: false },
          { name: 'role_id', type: 'bigint', pk: true, fk: 'roles.id', nullable: false, unique: false },
          { name: 'granted_at', type: 'timestamptz', pk: false, fk: null, nullable: false, unique: false },
        ],
        indexes: ['(role_id) — who has this role'],
      },
      {
        id: 'role_permissions',
        name: 'role_permissions',
        columns: [
          { name: 'role_id', type: 'bigint', pk: true, fk: 'roles.id', nullable: false, unique: false },
          { name: 'permission_id', type: 'bigint', pk: true, fk: 'permissions.id', nullable: false, unique: false },
        ],
        indexes: ['(permission_id)'],
      },
    ],
    relations: [
      { from: 'user_roles', to: 'users', kind: 'one-to-many', label: null },
      { from: 'user_roles', to: 'roles', kind: 'one-to-many', label: null },
      { from: 'role_permissions', to: 'roles', kind: 'one-to-many', label: null },
      { from: 'role_permissions', to: 'permissions', kind: 'one-to-many', label: null },
    ],
  },
  explanation: {
    title: 'Role-Based Access Control (RBAC)',
    summary:
      'Instead of granting permissions to each user, you grant them to roles (admin, editor, viewer) and give users roles. Access checks become "does any of this user\'s roles include this permission?".',
    sections: [
      {
        heading: 'Overview',
        body: 'Two different questions are involved, and mixing them up is the most common mistake:\n- Authentication (authN): who are you? Answered at login. Failure is 401 Unauthorized.\n- Authorization (authZ): what may you do? Answered on every request. Failure is 403 Forbidden.\n\nRBAC is a way to answer the second question that stays manageable as users grow: you manage a handful of roles instead of thousands of individual grants.',
      },
      {
        heading: 'Core model',
        body: '- A permission is an action on a resource, written like "invoice:read" or "invoice:approve".\n- A role is a named set of permissions, like "accountant".\n- A user has one or more roles. Their effective permissions are the union of their roles\' permissions.\n\nBoth links are many-to-many, which is why the database uses two join tables: user_roles and role_permissions.\n\nPrinciples: deny by default (no matching permission means no access), and least privilege (give each role only what it needs).',
      },
      {
        heading: 'Step by step',
        body: '1. User signs in through the Client App, which sends credentials to the Login Service.\n2. The Login Service verifies the password hash and loads the user\'s roles from Users & Roles DB.\n3. Issue JWT (roles claim): it returns a signed, short-lived token containing the user id and roles.\n4. The Client App calls the API Gateway with "Authorization: Bearer <JWT>".\n5. Token valid? The gateway checks the signature and expiry. If not, 401 Unauthorized.\n6. Policy Check maps the roles to permissions for this route (for example, DELETE /invoices needs invoice:delete).\n7. Has permission? Yes: the request reaches the Protected Service. No: 403 Forbidden.\n8. Every decision is written to the Audit Log, so you can answer "who did what, and who was refused".',
      },
      {
        heading: 'Components',
        body: '- Login Service: authenticates users and issues tokens. It is the only place that sees passwords.\n- Users & Roles DB: the source of truth for users, roles, permissions and the links between them.\n- Issue JWT (roles claim): signs the token (RS256 lets any service verify it with the public key).\n- API Gateway: checks the token once at the edge, so services do not each re-implement it.\n- Policy Check: turns roles into permissions for the requested action; can live in the gateway or a shared library.\n- Protected Service: still checks ownership rules itself (see "Where to enforce").\n- Audit Log: append-only record of access decisions, required by most compliance standards.',
      },
      {
        heading: 'Where to enforce',
        body: 'Coarse checks ("only editors may call POST /articles") fit well in the gateway. Fine-grained checks ("editors may edit only their own drafts") need data the gateway does not have, so the service enforces them.\n\nWhen rules depend on attributes (owner, department, time of day), RBAC alone stops scaling. That is where ABAC (attribute-based access control) or relationship-based models (like Google Zanzibar) come in; many real systems combine RBAC with a few attribute checks.',
      },
      {
        heading: 'Key decisions',
        body: '- Roles in the token vs looked up per request. Roles in the JWT avoid a database call on every request, but changes (like removing a role) only take effect when the token expires. Typical answer: short-lived access tokens (about 5 to 15 minutes) plus refresh tokens, with permissions cached per role.\n- Permission naming: "resource:action" strings are easy to read, check and audit.\n- Role design: start with a few broad roles. Too many fine-grained roles ("role explosion") is as hard to manage as per-user grants.\n- Revocation: for urgent cases (a fired employee), keep a short denylist of revoked token ids until they expire.',
      },
      {
        heading: 'Scaling and failure',
        body: '- Permission checks run on every request, so cache role → permissions in memory; it changes rarely.\n- If the Identity Provider goes down, existing tokens keep working until they expire, but nobody new can sign in. Run it highly available.\n- Signing keys must rotate: publish the public keys (JWKS) so services can pick up new ones without redeploying.\n- Fail closed: if a permission check cannot be completed, deny the request rather than allow it.',
      },
      {
        heading: 'Interview follow-ups',
        body: '- A user\'s role is removed. How quickly does it take effect, and how would you make it immediate?\n- How would you let editors edit only their own articles?\n- How do you support role hierarchies, where admin inherits everything editor has?\n- Where do you store tokens in a browser, and how do you protect them from XSS and CSRF?\n- How would multi-tenant RBAC work, where roles differ per organization?',
      },
    ],
    trace: simulator.run(simulator.defaults),
    code: [
      {
        title: 'Permission middleware (Express)',
        language: 'typescript',
        source: `import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { NextFunction, Request, Response } from 'express'

// The Identity Provider's public keys; jose caches them and picks up rotations.
const JWKS = createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json'))

// Role → permissions, loaded from role_permissions and cached (it changes rarely).
const ROLE_PERMISSIONS: Record<string, string[]> = {
${roleTable}
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.get('authorization')?.replace(/^Bearer /, '')
    if (!token) return res.status(401).json({ error: 'missing token' })

    let roles: string[]
    try {
      // Checks signature, expiry and issuer in one call.
      const { payload } = await jwtVerify(token, JWKS, { issuer: 'https://auth.example.com' })
      roles = (payload.roles as string[] | undefined) ?? []
    } catch {
      return res.status(401).json({ error: 'invalid or expired token' }) // who are you?
    }

    // Deny by default: allowed only if one of the user's roles grants it.
    if (!roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission))) {
      return res.status(403).json({ error: \`missing permission \${permission}\` }) // not allowed
    }
    next()
  }
}

// app.delete('/articles/:id', requirePermission('article:delete'), deleteArticle)`,
      },
      {
        title: 'Issuing the token at login',
        language: 'typescript',
        source: `import { importPKCS8, SignJWT } from 'jose'

const privateKey = await importPKCS8(process.env.JWT_PRIVATE_KEY!, 'RS256')

export function issueAccessToken(userId: string, roles: string[]): Promise<string> {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-2026-10' })
    .setSubject(userId)
    .setIssuer('https://auth.example.com')
    .setIssuedAt()
    // Short-lived: a removed role stops working within 15 minutes.
    .setExpirationTime('15m')
    .sign(privateKey)
}`,
      },
      {
        title: 'Effective permissions in SQL',
        language: 'sql',
        source: `-- Everything a user may do: the union of their roles' permissions.
-- Walks user_roles (primary key starts with user_id) then role_permissions.
SELECT DISTINCT p.resource || ':' || p.action AS permission
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id
JOIN permissions p       ON p.id = rp.permission_id
WHERE ur.user_id = $1;

-- Who may delete articles? Uses the index on role_permissions(permission_id).
SELECT DISTINCT u.email
FROM permissions p
JOIN role_permissions rp ON rp.permission_id = p.id
JOIN user_roles ur       ON ur.role_id = rp.role_id
JOIN users u             ON u.id = ur.user_id
WHERE p.resource = 'article' AND p.action = 'delete';`,
      },
    ],
    related: ['JWT and refresh tokens', 'OAuth 2.0 and OpenID Connect', 'ABAC', 'API gateway', 'Multi-tenancy'],
  },
  simulator,
}
