import type { Lesson } from '../lessonTypes'

const lesson: Lesson = {
  cards: [
    {
      title: 'Who are you, and what may you do?',
      text: 'Authentication checks who you are, usually with a login. Authorization checks what you may do. Getting them wrong gives two different errors: 401 and 403.',
      focus: ['User', 'Login Service', 'Policy Check'],
      remember: '401: we don\'t know you. 403: we know you, but no.',
    },
    {
      title: 'Permissions go to roles',
      text: 'You don\'t give permissions to each person. You give them to roles, like admin, editor and viewer. Then you give each user one or more roles.',
      focus: ['Users & Roles DB'],
      example: 'editor → posts:read, posts:write\nviewer → posts:read\nasha → editor',
    },
    {
      title: 'Name permissions resource:action',
      text: 'A permission like "posts:write" says what (posts) and which action (write). These names are easy to read, check and audit.',
    },
    {
      title: 'Roles travel in the token',
      text: 'After login, the Login Service gives the app a JWT, a signed token. It carries the user\'s roles. The API Gateway can then check roles without asking the database each time.',
      focus: ['Login Service', 'Issue JWT (roles claim)', 'API Gateway'],
      example: '{ "sub": "asha", "roles": ["editor"], "exp": 1764000900 }',
    },
    {
      title: 'Bad token: 401',
      text: 'The gateway first checks the token: is it signed by us, and not expired? If not, the answer is 401 Unauthorized, and the request stops there.',
      focus: ['API Gateway', 'Token valid?', '401 Unauthorized'],
    },
    {
      title: 'No permission: 403',
      text: 'With a good token, the Policy Check asks: does any of this user\'s roles have this permission? If not, the answer is 403 Forbidden. Deny by default: anything not granted is refused.',
      focus: ['Policy Check', 'Has permission?', '403 Forbidden', 'Protected Service'],
    },
    {
      title: 'Short tokens, quick removal',
      text: 'Roles in a token can\'t change until it expires. So access tokens live only 5 to 15 minutes. For urgent cases, like a fired employee, keep a short list of revoked tokens.',
      focus: ['Issue JWT (roles claim)'],
    },
    {
      title: 'Write every decision down',
      text: 'The Audit Log records every allow and every refusal: who, what, when. It answers "who deleted this?" and shows attacks early.',
      focus: ['Audit Log'],
    },
  ],
  quiz: [
    {
      question: 'A logged-in viewer tries to delete a post. What should they get?',
      options: ['401 Unauthorized', '403 Forbidden', '200 OK', '404 Not Found'],
      answer: 1,
      why: 'We know who they are (valid token), but their role lacks posts:delete, so it is a 403.',
    },
    {
      question: 'You remove the admin role from a user. Why might they still act as admin for a few minutes?',
      options: ['The database is slow', 'Their JWT still carries the old roles until it expires', 'The audit log is late', 'Roles are cached forever'],
      answer: 1,
      why: 'Roles travel in the signed token, so changes apply when it expires. Short-lived tokens keep that window small.',
    },
    {
      question: 'What is the main reason to grant permissions to roles, not users?',
      options: ['Tokens get smaller', 'It is easier to manage and audit many users', 'It removes the need for login', 'It makes requests faster'],
      answer: 1,
      why: 'You change one role instead of hundreds of users, and it is easy to see who can do what.',
    },
  ],
}

export default lesson
