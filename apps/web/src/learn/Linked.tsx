import { Fragment, useMemo } from 'react'
import { TOPICS } from '../topics/catalog'
import { hrefOf, linkText, type LinkRule, type Linked } from './links'

// Rendering for deep links (learn/links.ts). App.tsx opens any a[data-topic-link]
// in the app and scrolls to the section the link names.

const titleOf = (rule: LinkRule) => {
  const title = TOPICS.find((t) => t.id === rule.topic)?.title ?? rule.topic
  return rule.section ? `${title} › ${rule.section.replace(/^\W+\s*/u, '')}` : title
}

export function TopicLink({ rule, read, children }: { rule: LinkRule; read: boolean; children: React.ReactNode }) {
  return (
    <a href={hrefOf(rule, read)} className="topic-link" data-topic-link title={`Explained in ${titleOf(rule)}`}>
      {children}
    </a>
  )
}

/** Text from linkText(), with its links. `read`: topic links open Read mode. */
export function Parts({ parts, read }: { parts: Linked[]; read: boolean }) {
  return (
    <>
      {parts.map((p, i) =>
        p.rule ? (
          <TopicLink key={i} rule={p.rule} read={read}>
            {p.text}
          </TopicLink>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  )
}

/** Several short texts linked as one section (takeaways, walkthrough steps): each target once. */
export function useLinkedList(texts: readonly string[], from: string | undefined): Linked[][] {
  const key = texts.join('\u0000')
  return useMemo(() => {
    if (!from) return texts.map((text) => [{ text }])
    const used = new Set<string>()
    return texts.map((text) => linkText(text, from, used))
  }, [key, from]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The topic a "Learn next" name stands for, when its title starts with that name. */
export function topicNamed(name: string) {
  const n = name.toLowerCase()
  return TOPICS.find((t) => t.title.toLowerCase().startsWith(n) || t.id === n.replace(/\s+/g, '-')) ?? null
}
