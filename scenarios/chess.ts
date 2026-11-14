import type { Scenario } from '#e2e/scenarios/index.ts'

export const FOG = 'https://www.chess.com/variants/fog-of-war'
export const GAME = `${FOG}/game/112126760`

// A blitz game of Fog of War, won by taking the king: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7
// Kxf7 7. Qf3 Ke6 8. Nc3 Nb4 9. a3 Nxc2 10. Kd1 Nxa1 11. Nxd5 Qh4 12. Nxc7 Kd6 13. Qd5 Kxd5 14. Bxd5, each move with
// how long its player thought, in ms.
export const MOVES: [string, number][] = [
  ['e2e4', 1400],
  ['e7e5', 2100],
  ['g1f3', 900],
  ['b8c6', 1800],
  ['f1c4', 1200],
  ['g8f6', 3900],
  ['f3g5', 2600],
  ['d7d5', 5200],
  ['e4d5', 800],
  ['f6d5', 4100],
  ['g5f7', 7300],
  ['e8f7', 2200],
  ['d1f3', 1900],
  ['f7e6', 9800],
  ['b1c3', 3100],
  ['c6b4', 6400],
  ['a2a3', 2500],
  ['b4c2', 3300],
  ['e1d1', 4800],
  ['c2a1', 1600],
  ['c3d5', 8700],
  ['d8h4', 12400],
  ['d5c7', 5600],
  ['e6d6', 7700],
  ['f3d5', 14200],
  ['d6d5', 2900],
  ['c4d5', 1100],
]

const START = Date.parse('2026-11-11T01:50:54.000Z')

// A square as the site writes it, on a four-player board whose middle is the eight by eight: "e2" is "h5".
function siteSquare(square: string) {
  return `${String.fromCharCode(square.charCodeAt(0) + 3)}${Number(square[1]) + 3}`
}

// The game's PGN4 as the site keeps it: each move with when it was made and its player's clock after it.
export function pgn4() {
  let time = START
  const clocks = [180000, 180000]
  const moves = MOVES.map(([move, thought], i) => {
    time += thought
    clocks[i % 2] += 2000 - thought
    const head = i % 2 ? '..' : `${i / 2 + 1}.`
    return `${head} ${siteSquare(move.slice(0, 2))}-${siteSquare(move.slice(2, 4))} { date=${new Date(time).toISOString()} clock=${clocks[i % 2]} }`
  })
  return `[GameNr "112126760"]\n[TimeControl "3+2"]\n[White "Zelfmat76"]\n[Black "szlive"]\n\n${moves.join(' ')} .. #`
}

interface Player {
  name: string
  rating: number
}

// A game as the site keeps it in its stores, by default Zelfmat76 (2626) against szlive (2434).
export function fogGame(gameNr = 112126760, white: Player = { name: 'Zelfmat76', rating: 2626 }, black: Player = { name: 'szlive', rating: 2434 }) {
  return {
    gameNr,
    date: new Date(START).toISOString(),
    endDate: new Date(START + MOVES.reduce((sum, [, thought]) => sum + thought, 0) + 500).toISOString(),
    rated: true,
    timeControlInitial: 3,
    timeControlIncrement: 2,
    result: '1-0',
    termination: 'King captured • 1-0',
    username1: white.name,
    rating1: white.rating,
    ratingDiff1: 3.1,
    username3: black.name,
    rating3: black.rating,
    ratingDiff3: -3.1,
    q: { timeControlType: 'blitz', ruleVariants: { fogOfWar: true } },
    pgn4: pgn4(),
  }
}

// A page of the site's variants app, which fills its store once running with what it was sent. Its scripts are held to
// a policy that runs only its own, as a scraper in the page's world must run whatever the page allows. after is more
// of the page's script, run first.
function appPage(title: string, store: string, state: unknown, after = '') {
  const body = `<!doctype html><title>${title} - Chess.com</title><div id="app"></div>
<script nonce="app">
const stores = new Map([['${store}', {}]])
document.querySelector('#app').__vue_app__ = { config: { globalProperties: { $pinia: { _s: stores } } } }
${after}
setTimeout(() => { Object.assign(stores.get('${store}'), ${JSON.stringify(state)}) }, 500)
</script>`
  return { headers: { 'Content-Security-Policy': 'script-src \'nonce-app\'; object-src \'none\'' }, body }
}

// A game's page, which writes where in the game it is into its address.
export function gamePage(game = fogGame()) {
  return appPage(`Fog of War Chess - ${game.username1} vs ${game.username3}`, 'game', { game }, `history.replaceState(null, '', location.pathname + '/${MOVES.length}/1')`)
}

// The leaderboards, opening on games played, as the site's do, and never choosing the tab the parser asks for.
export function stuckLeaderboardPage() {
  const state = {
    leaderboardTypes: ['blitz', 'rapid'].map(speed => ({ leaderboardType: `rt:fogofwar:${speed}`, name: `Fog Of War ${speed}` })),
    leaderboard: { leaderboardType: 'numGamesTotal', leaders: [{ username: 'ann', rating: 2400 }] },
  }
  return appPage('Play Chess Variants Online', 'leaderboards', state, `stores.get('leaderboards').selectType = () => {}`)
}

// A player's games, the newest first.
export function archivePage(player: string, games: ReturnType<typeof fogGame>[]) {
  return appPage(`Fog of War Chess - Archive - ${player}`, 'archive', { foundGames: games, isLastArchivePage: true })
}

export function archiveUrl(player: string) {
  return `${FOG}/archive&p=${player}&gameType=2pc&daysBack=0-9999`
}

export const chess: Scenario = {
  about: 'a Fog of War game from chess.com, scraped and open in Read, its board ready to play back',
  async run({ app, site }) {
    site.serve(GAME, gamePage())
    await app.scrape(GAME)
    await app.go(`#/?q=${encodeURIComponent(`item="${GAME}"`)}&v=record`)
    await app.page.locator('.reader-chess').waitFor()
    await app.page.waitForTimeout(500)
  },
}

export default chess
