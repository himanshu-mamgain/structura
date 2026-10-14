import { LearnPanel } from './learn/LearnPanel'
import { BoardCanvas, PageBar } from './board/react'
import { board } from './board/store'
import { InstallButton } from './pwa/InstallButton'

export default function App() {
  return (
    <div className="app">
      <BoardCanvas board={board} />
      <PageBar board={board} />
      <LearnPanel board={board} />
      <InstallButton />
    </div>
  )
}
