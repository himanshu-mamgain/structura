// Builds src/topics/library.json, Structura's syllabus, from several sources:
//
// - ByteByteGo's System Design 101 (github.com/ByteByteGoHq/system-design-101),
//   CC BY-NC-ND 4.0 (no derivatives): only each guide's title, categories, tags
//   and a link are kept. No article text, descriptions or images.
// - AWS containers on Terraform (see "AWS containers on Terraform" below): links to
//   the aws-samples ECS full-stack app, terraform-aws-modules and the containers roadmap.
// - Donne Martin's System Design Primer (github.com/donnemartin/system-design-primer),
//   CC BY 4.0: its concept chapters and worked designs, linked by section. Being
//   CC BY, Structura topics may be adapted from it, with credit.
// - PingCAP's Awesome Database Learning (github.com/pingcap/awesome-database-learning):
//   no licence given, so only its section headings are kept, each linked to that
//   section of its README. Its curated list itself is not copied.
//
//   node scripts/kb-sync.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'ByteByteGoHq/system-design-101'
const RAW = `https://raw.githubusercontent.com/${REPO}/main`
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/topics/library.json')

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'structura-kb-sync' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

async function text(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

/** Reads the YAML front matter fields we need: plain strings and simple lists. */
function frontMatter(source) {
  const block = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const fields = {}
  let list = null
  for (const line of block.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && list) {
      fields[list].push(item[1].trim().replace(/^['"]|['"]$/g, ''))
      continue
    }
    const pair = line.match(/^([A-Za-z]+):\s*(.*)$/)
    if (!pair) continue
    const [, key, value] = pair
    if (value === '') {
      list = key
      fields[key] = []
    } else {
      list = null
      fields[key] = value.trim().replace(/^['"]|['"]$/g, '').replace(/''/g, "'")
    }
  }
  return fields
}

/** Runs `task` over `items`, `limit` at a time. */
async function pool(items, limit, task) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await task(items[i])
      }
    }),
  )
  return results
}

const tree = await json(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`)
const files = tree.tree.map((f) => f.path)
const guideFiles = files.filter((p) => /^data\/guides\/[^/]+\.md$/.test(p))
const categoryFiles = files.filter((p) => /^data\/categories\/[^/]+\.md$/.test(p))

const categories = (
  await pool(categoryFiles, 8, async (path) => {
    const fm = frontMatter(await text(`${RAW}/${path}`))
    return { id: path.split('/').pop().replace(/\.md$/, ''), title: fm.title, sort: Number(fm.sort ?? 999) }
  })
).sort((a, b) => a.sort - b.sort)

const guides = (
  await pool(guideFiles, 12, async (path) => {
    const fm = frontMatter(await text(`${RAW}/${path}`))
    if (fm.draft === 'true') return null
    const slug = path.split('/').pop().replace(/\.md$/, '')
    return { slug, title: fm.title, categories: fm.categories ?? [], tags: fm.tags ?? [] }
  })
)
  .filter(Boolean)
  .sort((a, b) => a.title.localeCompare(b.title))

// ─── System Design Primer: its README's concept chapters and worked designs ───

const PRIMER_URL = 'https://github.com/donnemartin/system-design-primer'
const readme = await text('https://raw.githubusercontent.com/donnemartin/system-design-primer/master/README.md')
/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
const anchor = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
const lines = readme.split(/\r?\n/)
const from = lines.indexOf('## Performance vs scalability')
const to = lines.indexOf('## Appendix')
const concepts = []
for (const line of lines.slice(from, to)) {
  if (line.startsWith('## ')) {
    const title = line.slice(3)
    concepts.push({ slug: `primer-${anchor(title)}`, title, categories: ['primer-concepts'], tags: [], url: `${PRIMER_URL}#${anchor(title)}` })
  } else if (line.startsWith('### ') && concepts.length && !/^(Source|Disadvantage)/.test(line.slice(4))) {
    concepts.at(-1).tags.push(line.slice(4))
  }
}
for (const c of concepts) c.tags = c.tags.slice(0, 4)
const solutions = [...readme.matchAll(/^### (Design .+)$/gm)]
  .map((m) => m[1].trim())
  .filter((t) => !/hash map|parking lot|call center|deck of cards|chat server|least recently used/i.test(t))
  .map((title) => ({ slug: `primer-${anchor(title)}`, title, categories: ['primer-solutions'], tags: [], url: `${PRIMER_URL}#${anchor(title)}` }))

// ─── Community diagrams (no licence: linked, nothing copied) ───

const DIAGRAMS = 'https://github.com/Chaki34/system-design-diagrams'
const diagramTree = await json('https://api.github.com/repos/Chaki34/system-design-diagrams/git/trees/HEAD?recursive=1')
const diagramFolders = [...new Set(diagramTree.tree.filter((f) => f.type === 'tree' && !f.path.includes('/')).map((f) => f.path))]
const diagrams = diagramFolders.map((folder) => ({
  slug: `diagrams-${folder.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  title: folder.replace(/^System Design - /, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  categories: ['community-diagrams'],
  tags: ['diagrams'],
  url: `${DIAGRAMS}/tree/HEAD/${encodeURIComponent(folder)}`,
}))

// ─── awesome-scalability (MIT): its curated reading list, by section ───

const SCALABILITY = 'https://github.com/binhnguyennus/awesome-scalability'
const scalabilityReadme = await text('https://raw.githubusercontent.com/binhnguyennus/awesome-scalability/master/README.md')
const scalabilitySections = []
const scalabilityLinks = []
let section = null
let subsection = null
for (const line of scalabilityReadme.split(/\r?\n/)) {
  const heading = line.match(/^## (.+)$/)
  if (heading) {
    section = /^(Content|A Piece of Cake)$/.test(heading[1]) ? null : heading[1].trim()
    subsection = null
    if (section) scalabilitySections.push(section)
    continue
  }
  if (!section) continue
  const link = line.match(/^\s*\* \[([^\]]+)\]\((https?:[^)\s]+)\)/)
  if (link) {
    const id = `scalability-${anchor(section)}`
    // Slugs come from the title (not the position) so links to them survive list changes.
    let slug = `scale-${anchor(link[1]).slice(0, 70).replace(/-+$/, '')}`
    while (scalabilityLinks.some((l) => l.slug === slug)) slug += '-2'
    scalabilityLinks.push({
      slug,
      title: link[1].trim(),
      categories: [id],
      tags: subsection ? [subsection] : [],
      url: link[2],
    })
  } else {
    // A bullet without a link names a group of links under it ("* Load Balancing").
    const group = line.match(/^\s*\* ([^[].*)$/)
    if (group) subsection = group[1].trim()
  }
}

// ─── Awesome Database Learning (no licence): linked by section only ───

const DB_LEARNING = 'https://github.com/pingcap/awesome-database-learning'
const dbReadme = await text('https://raw.githubusercontent.com/pingcap/awesome-database-learning/master/README.md')
const dbLinks = []
let dbSection = null
for (const line of dbReadme.split(/\r?\n/)) {
  const heading = line.match(/^(##|###) (.+)$/)
  if (!heading) continue
  const title = heading[2].trim()
  if (heading[1] === '##') dbSection = title === 'Table of Contents' ? null : title
  if (!dbSection) continue
  dbLinks.push({
    slug: `db-${anchor(title).replace(/-+/g, '-')}`,
    title: heading[1] === '##' ? `Database internals: ${title}` : `Database internals: ${dbSection} › ${title}`,
    categories: ['db-learning'],
    tags: ['Databases'],
    url: `${DB_LEARNING}#${anchor(title)}`,
  })
}

// ─── Projects and tutorials worth knowing (linked; licences noted) ───

const references = [
  { slug: 'ref-apache-kafka-docs', title: 'Apache Kafka documentation: design and implementation', url: 'https://kafka.apache.org/documentation/#design', tags: ['Kafka', 'Apache 2.0'] },
  { slug: 'ref-apache-kafka', title: 'Apache Kafka source code', url: 'https://github.com/apache/kafka', tags: ['Kafka', 'Apache 2.0'] },
  { slug: 'ref-kafka-nodejs-tutorial', title: 'Kafka with Node.js and Docker: a sample application', url: 'https://github.com/billonline33/kafka-nodejs-tutorial', tags: ['Kafka', 'Node.js'] },
  { slug: 'ref-docker-curriculum', title: 'Docker for beginners: a comprehensive tutorial', url: 'https://docker-curriculum.com/', tags: ['Docker', 'MIT'] },
  { slug: 'ref-awesome-system-design-resources', title: 'Awesome system design resources (free interview prep)', url: 'https://github.com/ashishps1/awesome-system-design-resources', tags: ['Interviews', 'GPL-3.0'] },
  { slug: 'ref-awesome-scalability', title: 'Awesome Scalability: patterns of large-scale systems', url: SCALABILITY, tags: ['Scalability', 'MIT'] },
  { slug: 'ref-awesome-database-learning', title: 'Awesome Database Learning: papers, courses and talks on database internals', url: DB_LEARNING, tags: ['Databases', 'Link only'] },
].map((r) => ({ ...r, categories: ['references'], source: 'references' }))

// ─── AWS containers on Terraform (adaptable with credit; the roadmap is linked only) ───
//
// - aws-samples/amazon-ecs-fullstack-app-terraform: MIT-0, a full-stack app on ECS.
// - terraform-aws-modules (ECS, VPC, ALB): Apache 2.0, the modules most teams start from.
// - aws/containers-roadmap: CC BY-SA 4.0, so linked only (adapting it would make ours share-alike).

const GH = 'https://github.com'
const ECS_SAMPLE = `${GH}/aws-samples/amazon-ecs-fullstack-app-terraform`
const TF = (mod, path = '') => `${GH}/terraform-aws-modules/terraform-aws-${mod}${path ? `/tree/master/${path}` : ''}`
const aws = [
  // The full-stack sample, section by section.
  { slug: 'aws-ecs-fullstack-sample', title: 'Amazon ECS full-stack app with Terraform (Vue.js + Node.js on Fargate)', url: ECS_SAMPLE, tags: ['ECS', 'Terraform', 'MIT-0'], categories: ['aws-sample'] },
  { slug: 'aws-ecs-fullstack-infrastructure', title: 'Full-stack sample: infrastructure architecture (VPC, 2 ALBs, ECS, DynamoDB, S3)', url: `${ECS_SAMPLE}#infrastructure-architecture`, tags: ['ECS', 'ALB', 'VPC'], categories: ['aws-sample'] },
  { slug: 'aws-ecs-fullstack-cicd', title: 'Full-stack sample: CI/CD with CodePipeline, CodeBuild and blue/green CodeDeploy', url: `${ECS_SAMPLE}#cicd-architecture`, tags: ['CI/CD', 'Blue/green'], categories: ['aws-sample'] },
  { slug: 'aws-ecs-fullstack-autoscaling', title: 'Full-stack sample: testing ECS service autoscaling', url: `${ECS_SAMPLE}#autoscaling-test`, tags: ['ECS', 'Autoscaling'], categories: ['aws-sample'] },
  { slug: 'aws-ecs-fullstack-modules', title: 'Full-stack sample: its Terraform modules (Networking, ALB, ECS, IAM, CodePipeline…)', url: `${ECS_SAMPLE}/tree/main/Infrastructure/Modules`, tags: ['Terraform'], categories: ['aws-sample'] },
  // terraform-aws-ecs
  { slug: 'tf-aws-ecs', title: 'terraform-aws-ecs: ECS clusters, services and task definitions', url: TF('ecs'), tags: ['ECS', 'Terraform', 'Apache 2.0'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-ecs-fargate', title: 'terraform-aws-ecs example: a service on Fargate', url: TF('ecs', 'examples/fargate'), tags: ['ECS', 'Fargate'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-ecs-ec2-autoscaling', title: 'terraform-aws-ecs example: EC2 capacity with Auto Scaling groups', url: TF('ecs', 'examples/ec2-autoscaling'), tags: ['ECS', 'EC2'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-ecs-complete', title: 'terraform-aws-ecs example: complete (cluster, services, capacity providers)', url: TF('ecs', 'examples/complete'), tags: ['ECS'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-ecs-service-module', title: 'terraform-aws-ecs service module: deployments, autoscaling, load balancer wiring', url: TF('ecs', 'modules/service'), tags: ['ECS'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-ecs-container-definition', title: 'terraform-aws-ecs container definition module', url: TF('ecs', 'modules/container-definition'), tags: ['ECS', 'Containers'], categories: ['aws-terraform'] },
  // terraform-aws-vpc
  { slug: 'tf-aws-vpc', title: 'terraform-aws-vpc: VPCs, subnets, route tables, NAT and internet gateways', url: TF('vpc'), tags: ['VPC', 'Terraform', 'Apache 2.0'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-vpc-simple', title: 'terraform-aws-vpc example: a simple VPC with public and private subnets', url: TF('vpc', 'examples/simple'), tags: ['VPC'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-vpc-complete', title: 'terraform-aws-vpc example: complete (database subnets, NAT, endpoints)', url: TF('vpc', 'examples/complete'), tags: ['VPC'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-vpc-endpoints', title: 'terraform-aws-vpc VPC endpoints module: reach AWS services without NAT', url: TF('vpc', 'modules/vpc-endpoints'), tags: ['VPC', 'PrivateLink'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-vpc-flow-log', title: 'terraform-aws-vpc example: VPC flow logs', url: TF('vpc', 'examples/flow-log'), tags: ['VPC', 'Observability'], categories: ['aws-terraform'] },
  // terraform-aws-alb
  { slug: 'tf-aws-alb', title: 'terraform-aws-alb: Application and Network Load Balancers', url: TF('alb'), tags: ['ALB', 'Terraform', 'Apache 2.0'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-alb-complete', title: 'terraform-aws-alb example: complete ALB (listeners, rules, target groups)', url: TF('alb', 'examples/complete-alb'), tags: ['ALB'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-alb-patterns', title: 'terraform-aws-alb patterns: HTTPS redirects, fixed responses, authenticated listeners', url: `${GH}/terraform-aws-modules/terraform-aws-alb/blob/master/docs/patterns.md`, tags: ['ALB', 'TLS'], categories: ['aws-terraform'] },
  { slug: 'tf-aws-nlb-complete', title: 'terraform-aws-alb example: complete Network Load Balancer', url: TF('alb', 'examples/complete-nlb'), tags: ['NLB'], categories: ['aws-terraform'] },
  // The containers roadmap (linked only)
  { slug: 'aws-containers-roadmap', title: 'AWS containers roadmap: what is coming to ECS, ECR, Fargate and EKS', url: `${GH}/aws/containers-roadmap`, tags: ['ECS', 'EKS', 'CC BY-SA 4.0'], categories: ['aws-roadmap'] },
  { slug: 'aws-containers-roadmap-board', title: 'AWS containers roadmap board (issues by stage)', url: `${GH}/aws/containers-roadmap/projects/1`, tags: ['Roadmap'], categories: ['aws-roadmap'] },
].map((r) => ({ ...r, source: 'aws' }))

writeFileSync(
  out,
  `${JSON.stringify(
    {
      sources: {
        bytebytego: { name: 'ByteByteGo · System Design 101', repo: `https://github.com/${REPO}`, license: 'CC BY-NC-ND 4.0: titles and links only.' },
        primer: { name: 'System Design Primer (Donne Martin)', repo: PRIMER_URL, license: 'CC BY 4.0: topics adapted from it credit it.' },
        course: { name: 'System Design 101 course (Mominur Rahman)', repo: 'https://github.com/mominurr/system-design-101', license: 'MIT: quiz and glossary reused with its notice.' },
        diagrams: { name: 'System design diagrams (Chaki34)', repo: DIAGRAMS, license: 'No licence given: linked only.' },
        scalability: { name: 'Awesome Scalability (Binh Nguyen)', repo: SCALABILITY, license: 'MIT: the curated list of titles and links; each article belongs to its author.' },
        aws: { name: 'AWS containers on Terraform', repo: ECS_SAMPLE, license: 'aws-samples full-stack app MIT-0 and terraform-aws-modules Apache 2.0: topics adapted from them credit them. containers-roadmap CC BY-SA 4.0: linked only.' },
        databases: { name: 'Awesome Database Learning (PingCAP)', repo: DB_LEARNING, license: 'No licence given: its sections are linked only; nothing is copied.' },
        references: { name: 'Projects and tutorials', repo: 'https://kafka.apache.org/', license: 'Linked; each keeps its own licence (Kafka Apache 2.0, docker-curriculum MIT, awesome-system-design-resources GPL-3.0, link only).' },
      },
      categories: [
        { id: 'primer-concepts', title: 'Core concepts (Primer)', sort: 0, source: 'primer' },
        { id: 'primer-solutions', title: 'Worked designs (Primer)', sort: 1, source: 'primer' },
        ...categories.map((c) => ({ ...c, source: 'bytebytego' })),
        ...scalabilitySections.map((title, i) => ({ id: `scalability-${anchor(title)}`, title: `Scalability reading: ${title}`, sort: 5000 + i, source: 'scalability' })),
        { id: 'aws-sample', title: 'AWS: full-stack app on ECS (sample)', sort: 8000, source: 'aws' },
        { id: 'aws-terraform', title: 'AWS: Terraform modules (ECS, VPC, ALB)', sort: 8001, source: 'aws' },
        { id: 'aws-roadmap', title: 'AWS: containers roadmap', sort: 8002, source: 'aws' },
        { id: 'db-learning', title: 'Database internals (Awesome Database Learning)', sort: 8500, source: 'databases' },
        { id: 'references', title: 'Projects and tutorials', sort: 9000, source: 'references' },
        { id: 'community-diagrams', title: 'Community diagrams', sort: 9999, source: 'diagrams' },
      ],
      guides: [
        ...concepts.map((g) => ({ ...g, source: 'primer' })),
        ...solutions.map((g) => ({ ...g, source: 'primer' })),
        ...guides.map((g) => ({ ...g, source: 'bytebytego', url: `https://bytebytego.com/guides/${encodeURIComponent(g.slug)}/` })),
        ...references,
        ...aws,
        ...scalabilityLinks.map((g) => ({ ...g, source: 'scalability' })),
        ...dbLinks.map((g) => ({ ...g, source: 'databases' })),
        ...diagrams.map((g) => ({ ...g, source: 'diagrams' })),
      ],
    },
    null,
    1,
  )}\n`,
)
console.log(`${concepts.length} primer concepts, ${solutions.length} primer designs, ${guides.length} ByteByteGo guides, ${scalabilityLinks.length} scalability readings, ${dbLinks.length} database sections, ${references.length} references, ${aws.length} AWS links, ${diagrams.length} diagram sets → src/topics/library.json`)
