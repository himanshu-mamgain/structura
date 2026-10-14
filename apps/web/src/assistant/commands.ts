/**
 * Simple canvas commands handled instantly in the browser, with no AI call.
 * Only a request that is *just* the command matches: "clear the diagram" does,
 * "remove the cache from the diagram" does not (that one goes to the AI).
 */
export type LocalCommand = 'clear' | 'undo' | 'redo' | 'fit' | 'stop'

const THING = '(the |this |my |that )?(whole |entire )?(canvas|diagram|board|page|drawing|screen|shapes|everything|all|it)'

const COMMANDS: [LocalCommand, RegExp][] = [
  ['clear', new RegExp(`^(clear|reset|wipe|erase|empty|delete|remove)( out)?( ${THING})?$`)],
  ['clear', /^(start (over|fresh|again)|new (canvas|diagram|page)|clean (up )?(the )?(canvas|board|slate))$/],
  ['undo', /^(undo|undo (that|it|the last (change|edit|step))|go back|revert( that)?)$/],
  ['redo', /^(redo|redo (that|it))$/],
  ['fit', /^(zoom (to fit|out|to (fit )?(all|everything))|fit (to )?(screen|all|everything)|show (me )?(all|everything|the whole (diagram|canvas)))$/],
  ['stop', /^(stop|pause|cancel|quiet|shut up|stop (talking|speaking|it|that))$/],
]

/** The command a request asks for, or null if it needs the AI. */
export function matchCommand(request: string): LocalCommand | null {
  const text = request
    .toLowerCase()
    .replace(/[.!?,]/g, ' ')
    .replace(/^\s*(please|hey|ok|okay|can you|could you|would you|just)\s+/g, '')
    .replace(/\s+(please|now|for me)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return COMMANDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}
