// @world main
// Chess.com's Fog of War (https://www.chess.com/variants/fog-of-war): its leaderboards, a player's games and a game.
// The variants pages are an app that draws everything from what it is sent over its own connection, and keeps what it
// was sent in its stores (Pinia's, on the page's Vue app), which only the page's own world can read: hence the line
// above, which runs this scraper there. Nothing is asked of the site that the page would not ask itself: a game is
// what the page loaded, a player's further games are the page's "more" (as scrolling the list asks), and a leaderboard
// of another speed is the page's own tab for it.
//
// Addresses (the site writes its own options into the path, after an &):
// - /variants/fog-of-war/leaderboards: links to each speed's leaderboard.
// - /variants/fog-of-war/leaderboards&speed=rapid: one speed's leaders, linking to each one's games of that speed.
//   The speed is ours: the site drops what it does not know from the address once loaded, so the address the page
//   was loaded at is read instead (loadedUrl), and named as the page's (canonicalUrl).
// - /variants/fog-of-war/archive&p=<player>&gameType=2pc&daysBack=0-9999: a player's latest games, newest first; with
//   &speed=rapid, those of one speed, looked for a few pages back. It links to each game by the rating of the weaker of
//   its players (see ratingWeight), so that a search prefers games between strong players.
// - /variants/fog-of-war/game/<number>: a game, read as a board that plays it back (see chessBlock in dom.js). It links
//   to its speed's leaderboard and to each player's games, so that saving it teaches a search the speed and the
//   players: the pages that lead to more games like it.

const FOG_OF_WAR = 'https://www.chess.com/variants/fog-of-war'
// How many pages of a player's games are looked through for those of one speed, and how many are enough.
const SPEED_PAGES = 5
const SPEED_GAMES = 10
// How long the parser waits, all told, for what the site sends the page: a scrape has 15 s in all, the page's loading
// included, and a parser that has not answered by then leaves nothing in the log to say why.
const PATIENCE = 9000

// A clock for the parser's waits: each waits as long as is left of its patience, and returns what it waited for.
function patience() {
  const deadline = Date.now() + PATIENCE
  return async (found) => {
    await waitFor(found, Math.max(0, deadline - Date.now()))
    return found()
  }
}

// A page the parser gave up on, as what it knows of it (a listing, its title, its address) and why (failed), which
// the scrape logs, counting it a failed scrape: what it waited for, and whether its tab was in the background, where
// a page's scripts may hold back. Nothing of the page's own text is kept, as it is only the site's menus.
function gaveUp(what, known) {
  return {
    content: [],
    links: [],
    ...known,
    failed: `chess.com did not send ${what} in ${PATIENCE / 1000} s (the tab was ${document.visibilityState})`,
  }
}

function fogStore(name) {
  return document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get(name)
}

// The address the page was loaded at, before the site rewrote it.
function loadedUrl() {
  return performance.getEntriesByType('navigation')[0]?.name || location.href
}

// The options the site writes into a path after its first & ("archive&p=ann&daysBack=0-9999").
function pathOptions(pathname) {
  const [page, ...options] = pathname.split('&')
  return {
    page,
    options: Object.fromEntries(options.map((option) => {
      const [name, value = ''] = option.split('=')
      return [name, decodeURIComponent(value)]
    })),
  }
}

function speedName(speed) {
  return speed ? speed.charAt(0).toUpperCase() + speed.slice(1) : ''
}

function leaderboardUrl(speed) {
  return `${FOG_OF_WAR}/leaderboards${speed ? `&speed=${speed}` : ''}`
}

function archiveUrl(player, speed) {
  return `${FOG_OF_WAR}/archive&p=${encodeURIComponent(player)}&gameType=2pc&daysBack=0-9999${speed ? `&speed=${speed}` : ''}`
}

function archiveTitle(player, speed) {
  return `${player}'s Fog of War ${speed ? `${speed} ` : ''}games`
}

function leaderboardTitle(speed) {
  return speed ? `Fog of War ${speedName(speed)} leaderboard` : 'Fog of War leaderboards'
}

function gameUrl(number) {
  return `${FOG_OF_WAR}/game/${number}`
}

// A game's speed, as the site names it (blitz, rapid, …), else as its clock makes it: its initial minutes and 40
// moves' increments.
function gameSpeed(game) {
  const named = game.q?.timeControlType
  if (named) {
    return named
  }
  const seconds = (game.timeControlInitial || 0) * 60 + 40 * (game.timeControlIncrement || 0)
  return seconds < 60 ? 'hyper' : seconds < 180 ? 'bullet' : seconds < 600 ? 'blitz' : 'rapid'
}

// The weaker player's rating, by which games are preferred: a game is as good as the worse of its two players. A player
// with none counts as new, at the rating the site starts them on.
const NEW_RATING = 1500

function minRating(game) {
  return Math.min(...gamePlayers(game).map(player => player.rating ?? NEW_RATING))
}

// How strongly a list links to a game, by its weaker player's rating: 1 at 2000, twice that for every 200 points more
// (4 at 2400), half for every 200 less (0.5 at 1800).
function ratingWeight(game) {
  return 2 ** ((minRating(game) - 2000) / 200)
}

function clockName(game) {
  return `${game.timeControlInitial} | ${game.timeControlIncrement}`
}

// A two-player game sits its players in the first and third of a four-player board's seats: white, then black.
function gamePlayers(game) {
  return [1, 3].map(seat => ({
    name: game[`username${seat}`],
    rating: game[`rating${seat}`] || undefined,
    change: game[`ratingDiff${seat}`],
  }))
}

// A square of the four-player board a game is written on ("f5"), on the eight by eight board in its middle ("c2"),
// whose files are its d to k and ranks its 4 to 11.
function boardSquare(file, rank) {
  const f = file.charCodeAt(0) - 'd'.charCodeAt(0)
  const r = Number(rank) - 3
  return f >= 0 && f < 8 && r >= 1 && r <= 8 ? `${String.fromCharCode(97 + f)}${r}` : null
}

const MOVE = /^[KQRBNP]?([a-n])(\d{1,2})[-x][KQRBNPD]?([a-n])(\d{1,2})(?:=([QRBND]))?[+#]*$/

// The moves of a game's PGN4 (its "1. f5-f7 { date=… clock=… } .. h10-h8 { … }"), each as a move from square to
// square ("c2c4", a promotion ending in its piece, "e7e8q"), with when it was made (ms after start) and the time left
// on its player's clock after it. Castling is written as the king's move. What is no move (R, a resignation) is left
// out.
function pgn4Moves(pgn4, start) {
  const moves = []
  const text = pgn4.replace(/^\[[^\n]*\]\s*$/gm, '')
  for (const [, number, token, comment = ''] of text.matchAll(/(?:(\d+)\.|\.\.)\s+(\S+)(?:\s+\{([^}]*)\})?/g)) {
    const white = Boolean(number)
    const castle = /^(O-O(?:-O)?)[+#]*$/.exec(token)?.[1]
    let uci = null
    if (castle) {
      const rank = white ? 1 : 8
      uci = `e${rank}${castle === 'O-O' ? 'g' : 'c'}${rank}`
    } else {
      const move = MOVE.exec(token)
      const from = move && boardSquare(move[1], move[2])
      const to = move && boardSquare(move[3], move[4])
      if (from && to) {
        const promotion = move[5] === 'D' ? 'q' : move[5]?.toLowerCase() ?? ''
        uci = `${from}${to}${promotion}`
      }
    }
    if (!uci) {
      continue
    }
    const date = /date=(\S+)/.exec(comment)?.[1]
    const clock = /clock=(\d+)/.exec(comment)?.[1]
    const time = date ? new Date(date).getTime() - start : Number.NaN
    moves.push({ uci, time: Number.isFinite(time) ? Math.max(0, time) : null, clock: clock ? Number(clock) : null })
  }
  return moves
}

// "Black resigned • 1-0" says how the game ended: "Black resigned".
function ending(termination) {
  return termination?.split('•')[0].trim() || undefined
}

// A rating's change, signed, or nothing where the site gives none.
function signed(change) {
  if (typeof change !== 'number') {
    return null
  }
  return change > 0 ? `+${change}` : change < 0 ? `−${-change}` : '±0'
}

async function parseGame(number) {
  const wait = patience()
  let game
  if (!await wait(() => (game = fogStore('game')?.game)?.gameNr === number && game.pgn4)) {
    return gaveUp(`game ${number}`, { untitled: true, canonicalUrl: gameUrl(number) })
  }
  const [white, black] = gamePlayers(game)
  const start = new Date(game.date).getTime()
  const moves = pgn4Moves(game.pgn4, start)
  const speed = gameSpeed(game)
  const title = `${white.name} vs ${black.name}`
  const lasted = game.endDate ? new Date(game.endDate).getTime() - start : (moves.at(-1)?.time ?? 0)
  const winner = game.result === '1-0' ? white : game.result === '0-1' ? black : null
  const timed = moves.every(move => move.time !== null && move.clock !== null)
  const fullMoves = Math.ceil(moves.length / 2)

  const content = [
    postBlock({
      title,
      authors: [white, black].map(player => ({ name: player.name, url: archiveUrl(player.name) })),
      time: isoTime(game.date),
    }),
    chessBlock({
      white: white.name,
      whiteUrl: archiveUrl(white.name),
      whiteRating: white.rating,
      black: black.name,
      blackUrl: archiveUrl(black.name),
      blackRating: black.rating,
      timeControl: `${game.timeControlInitial * 60}+${game.timeControlIncrement}`,
      start: isoTime(game.date),
      result: game.result,
      ending: ending(game.termination),
      moves: moves.map(move => move.uci),
      times: timed ? moves.map(move => move.time) : undefined,
      clocks: timed ? moves.map(move => move.clock) : undefined,
      fog: Boolean(game.q?.ruleVariants?.fogOfWar ?? true),
    }),
  ]

  // What the game is, beyond what its board shows, which Read shows in its side panel.
  const changes = [white, black].map(player => signed(player.change))
  const details = [
    ['variant', 'Fog of War'],
    ['speed', speedName(speed)],
    ['clock', clockName(game)],
    ['minrating', minRating(game)],
    ['players', [white, black].map(player => ({ text: player.name, url: archiveUrl(player.name) }))],
    ['ratings', [white.rating, black.rating].filter(Boolean)],
    ['rating changes', changes.every(Boolean) ? changes : null],
    ['result', game.result],
    ['winner', winner ? { text: winner.name, url: archiveUrl(winner.name) } : game.result === '1/2-1/2' ? 'Draw' : null],
    ['ending', ending(game.termination)],
    ['moves', fullMoves],
    ['minutes', Math.max(1, Math.round(lasted / 60000))],
    ['mode', game.rated ? 'Rated' : 'Casual'],
    ['played', isoTime(game.date)?.slice(0, 10)],
  ]

  const links = [
    { url: leaderboardUrl(speed), title: `Fog of War ${speedName(speed)} leaderboard`, score: 1 },
    ...[white, black].map(player => ({ url: archiveUrl(player.name), title: `${player.name}'s Fog of War games`, score: 1 })),
  ]
  return { title, content, details, links, canonicalUrl: gameUrl(number) }
}

// A player's latest games, as the page lists them, and, for one speed, as many further pages as it takes to find a
// few of that speed: those of another speed, or no Fog of War, or not the player's, are left out.
async function parseArchive(player, speed) {
  const wait = patience()
  let archive
  const found = () => (archive = fogStore('archive'))?.foundGames?.length
  // The page looks the player up by name and may leave it at that, listing players whose names begin so but choosing
  // none (as a background tab in Firefox does): the player of that very name is then chosen, as pressing it would.
  await Promise.race([wait(found), new Promise(resolve => setTimeout(resolve, 2500))])
  if (!found()) {
    const named = Array.from(document.querySelectorAll('.archive-search-auto-complete-username'))
      .find(choice => choice.textContent.replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase() === player.toLowerCase())
    named?.click()
  }
  if (!await wait(found)) {
    return gaveUp(`${player}'s games`, { listing: true, title: archiveTitle(player, speed), canonicalUrl: archiveUrl(player, speed) })
  }
  const plays = game => [1, 3].some(seat => game[`username${seat}`]?.toLowerCase() === player.toLowerCase())
    && game.q?.ruleVariants?.fogOfWar !== false
  const listed = () => archive.foundGames.filter(game => plays(game) && (!speed || gameSpeed(game) === speed))
  // Further pages while patience lasts: the games found by then are listed.
  for (let page = 1; page < (speed ? SPEED_PAGES : 1) && listed().length < SPEED_GAMES && !archive.isLastArchivePage; page++) {
    const before = archive.foundGames.length
    archive.incrementPage()
    if (!await wait(() => archive.foundGames.length > before)) {
      break
    }
  }
  const games = listed().filter((game, i, all) => all.findIndex(other => other.gameNr === game.gameNr) === i)
  return {
    listing: true,
    // Each game by its weaker player's rating, and a little less the further down the list it is, as the newest come
    // first.
    links: games.map((game, rank) => ({ url: gameUrl(game.gameNr), score: ratingWeight(game) / (1 + rank / 10) })),
    title: archiveTitle(player, speed),
    content: games.map((game) => {
      const [white, black] = gamePlayers(game)
      return `${white.name} (${white.rating ?? '?'}) vs ${black.name} (${black.rating ?? '?'}), ${gameSpeed(game)} ${clockName(game)}: ${game.result}`
    }),
    canonicalUrl: archiveUrl(player, speed),
  }
}

// The leaderboards: without a speed, a link to each speed's; with one, its leaders, each linking to their games of
// that speed, as the page's tab for that speed shows them.
async function parseLeaderboard(speed) {
  const wait = patience()
  let boards
  if (!await wait(() => (boards = fogStore('leaderboards'))?.leaderboardTypes?.length)) {
    return gaveUp('its leaderboards', { listing: true, title: leaderboardTitle(speed), canonicalUrl: leaderboardUrl(speed) })
  }
  const types = boards.leaderboardTypes.filter(type => type.leaderboardType?.startsWith('rt:fogofwar:'))
  if (!speed) {
    const speeds = types.map(type => type.leaderboardType.split(':')[2])
    return {
      listing: true,
      title: leaderboardTitle(),
      content: types.map(type => `${type.name}: ${type.numberOfActivePlayers?.toLocaleString('en')} active players`),
      links: speeds.map(name => ({ url: leaderboardUrl(name), title: `Fog of War ${speedName(name)} leaderboard`, score: 1 })),
      canonicalUrl: leaderboardUrl(),
    }
  }
  const type = `rt:fogofwar:${speed}`
  if (!types.some(known => known.leaderboardType === type)) {
    return null
  }
  // The page opens on a leaderboard of its own choosing (games played): the speed's tab is chosen, as the page does
  // when it is pressed, and chosen again if nothing has come of it in a few seconds.
  const shown = () => boards.leaderboard?.leaderboardType === type && boards.leaderboard.leaders?.length
  for (let tries = 0; !shown() && tries < 2; tries++) {
    boards.selectType(type)
    await (tries ? wait(shown) : Promise.race([wait(shown), new Promise(resolve => setTimeout(resolve, 3000))]))
  }
  if (!shown()) {
    const showing = boards.leaderboard?.leaderboardType
    return gaveUp(`its Fog of War ${speed} leaderboard, showing ${showing ? `${showing} (${boards.leaderboard.leaders?.length ?? 0} leaders)` : 'none'}`, { listing: true, title: leaderboardTitle(speed), canonicalUrl: leaderboardUrl(speed) })
  }
  const leaders = boards.leaderboard.leaders || []
  return {
    ...(listingOf(leaders.map(leader => archiveUrl(leader.username, speed))) ?? { listing: true }),
    title: leaderboardTitle(speed),
    content: leaders.map((leader, i) => `#${i + 1} ${leader.username} ${leader.rating}`),
    canonicalUrl: leaderboardUrl(speed),
  }
}

async function parseFogOfWar() {
  const loaded = new URL(loadedUrl())
  if (!/(?:^|\.)chess\.com$/.test(loaded.hostname)) {
    return null
  }
  const { page, options } = pathOptions(loaded.pathname.replace(/\/+$/, ''))
  const game = /^\/variants\/fog-of-war\/game\/(\d+)(?:\/|$)/.exec(page)
  if (game) {
    return parseGame(Number(game[1]))
  }
  if (page === '/variants/fog-of-war/archive' && options.p) {
    return parseArchive(options.p, options.speed)
  }
  if (page === '/variants/fog-of-war/leaderboards') {
    return parseLeaderboard(options.speed)
  }
  if (page === '/variants/fog-of-war') {
    return { listing: true, links: [leaderboardUrl(), ...['blitz', 'rapid', 'bullet', 'hyper'].map(leaderboardUrl)].map(url => ({ url, score: 1 })) }
  }
  return null
}

// The parser a scrape calls.
registerParser(parseFogOfWar)
