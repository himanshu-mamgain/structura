import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Every AWS request asks: is this allowed?',
      text: 'IAM (Identity and Access Management) checks every request made to AWS. Who is asking? What do they want to do? To which thing? If no rule says yes, the answer is no.',
      focus: ['People', 'IAM Policy Engine'],
      remember: 'The default answer is no.',
    },
    {
      title: 'Users are for people',
      text: 'An IAM user is one person, with a password to sign in. Give everyone their own user, or use single sign-on, and turn on MFA: a second check, such as a code from an app on their phone. Lock away the root user, the account\'s owner, and don\'t use it day to day.',
      focus: ['People'],
    },
    {
      title: 'Roles are for software',
      text: 'A role is an identity with no password or keys of its own. A service takes on the role and gets temporary credentials from STS (Security Token Service). By default they expire after an hour.',
      focus: ['Orders Service', 'Deploy Pipeline', 'STS'],
      remember: 'Never put long-lived keys in code. A key pushed to a public GitHub repository is often found within minutes.',
    },
    {
      title: 'Policies are the rules',
      text: 'A policy is a short JSON document. Each statement says the Effect (Allow or Deny), the Action (like dynamodb:PutItem), the Resource (which table or bucket) and, if you like, a Condition.',
      focus: ['Identity Policies'],
      example: '{\n  "Effect": "Allow",\n  "Action": "dynamodb:PutItem",\n  "Resource": "arn:aws:dynamodb:ap-south-1:111122223333:table/Orders"\n}',
    },
    {
      title: 'Least privilege',
      text: 'Give each identity only what its job needs. The Orders Service may add orders to the Orders table, and nothing else. Start from nothing and add; don\'t start from everything, like s3:*, and try to take things away.',
      focus: ['Orders Service', 'Identity Policies', 'DynamoDB Orders'],
    },
    {
      title: 'An explicit Deny always wins',
      text: 'AWS gathers every policy that applies to a request. If any of them says Deny, the answer is no, even when others say Allow. Use a Deny for things that must never happen, like deleting the photo bucket.',
      focus: ['IAM Policy Engine', 'Bucket Policy', 'S3 Bucket'],
    },
    {
      title: 'Guardrails that only limit',
      text: 'An SCP (service control policy) limits a whole account, for example "only use the Mumbai region". A permissions boundary sets the most a user or role can ever do, so a pipeline that creates roles can\'t create one stronger than itself.',
      focus: ['Organization SCP', 'Permissions Boundary', 'IAM Policy Engine'],
      remember: 'SCPs and boundaries never give permission. Something else still has to Allow.',
    },
    {
      title: 'CloudTrail keeps the record',
      text: 'CloudTrail records the API calls in your account: who made each one, when, and whether it was allowed. When something gets deleted, it\'s how you find out who did it.',
      focus: ['IAM Policy Engine', 'CloudTrail'],
      remember: 'Reads and writes of single S3 files are logged only if you turn on data events.',
    },
  ],
  quiz: [
    {
      question: 'Your Orders Service runs on AWS and writes to DynamoDB. What should it use?',
      options: ['An access key pasted into the code', 'A role, with temporary credentials from STS', 'The root user', 'Nothing: AWS trusts its own services'],
      answer: 1,
      why: 'Roles give short-lived credentials that renew themselves, so there\'s no key to leak.',
    },
    {
      question: 'One policy allows s3:DeleteObject and another denies it. What happens?',
      options: ['It\'s allowed, because an Allow wins', 'The newer policy wins', 'It\'s denied, because an explicit Deny always wins', 'AWS asks the account owner'],
      answer: 2,
      why: 'AWS checks for a Deny first. One Deny anywhere refuses the request.',
    },
    {
      question: 'What does a permissions boundary do?',
      options: ['Gives a role extra permissions', 'Logs every API call', 'Blocks a region for the whole company', 'Sets the most a user or role can ever be allowed'],
      answer: 3,
      why: 'It\'s a ceiling, not a grant. Blocking a region for a whole account is a job for an SCP.',
    },
  ],
}

export default lesson
