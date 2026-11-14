import { afterEach, describe, expect, it, vi } from 'vitest'
import { parserLoader, resetPage, visit } from '#scraper-test'

// The parser, evaluated with the helpers it is injected with, as a scrape runs it.
const load = parserLoader(__dirname)

afterEach(resetPage)

describe('chess.com fog of war', () => {
  const { parseFogOfWar } = load('chesscom-fog-of-war.js', ['parseFogOfWar'])
  const FOG = 'https://www.chess.com/variants/fog-of-war'

  // The page's app, holding these stores as Pinia does, which the scraper reads from the page's own world.
  function app(url: string, stores: Record<string, any>) {
    visit(url, '<div id="app"></div>')
    ;(document.querySelector('#app') as any).__vue_app__ = { config: { globalProperties: { $pinia: { _s: new Map(Object.entries(stores)) } } } }
  }

  function game(gameNr: number, white: string, black: string, timeControlType = 'blitz') {
    return {
      gameNr,
      date: '2026-11-11T01:50:54.000Z',
      rated: true,
      timeControlInitial: timeControlType === 'rapid' ? 10 : 3,
      timeControlIncrement: 2,
      result: '1-0',
      termination: 'Black resigned • 1-0',
      username1: white,
      rating1: 2100,
      ratingDiff1: 4.5,
      username3: black,
      rating3: 2000,
      ratingDiff3: -4.5,
      q: { timeControlType, ruleVariants: { fogOfWar: true } },
    }
  }

  // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O, then black resigns (R), on the four-player board's coordinates.
  const moves = ['h5-h7', 'h10-h8', 'Nj4-i6', 'Ne11-f9', 'Bi4-f7', 'Nj11-i9', 'O-O']
  const pgn4 = `[GameNr "7"]\n[White "ann"]\n[Black "bo"]\n\n${moves.map((move, i) =>
    `${i % 2 ? '..' : `${i / 2 + 1}.`} ${move} { date=2026-11-11T01:5${1 + Math.floor(i / 6)}:${String((i * 10) % 60).padStart(2, '0')}.000Z clock=${180000 - i * 1000} }`).join(' ')} .. R`

  it('reads a game as a board to play back, with its players, speed and result, and links to what leads to games like it', async () => {
    app(`${FOG}/game/7/20/1`, { game: { game: { ...game(7, 'ann', 'bo'), pgn4, endDate: '2026-11-11T01:52:24.000Z' } } })
    const parsed = await parseFogOfWar()
    expect(parsed.title).toBe('ann vs bo')
    expect(parsed.canonicalUrl).toBe(`${FOG}/game/7`)
    expect(parsed.content[1]).toMatch(/^<chess white="ann" white-url="[^"]+archive&amp;p=ann&amp;gameType=2pc&amp;daysBack=0-9999" white-rating="2100" black="bo" /)
    expect(parsed.content[1]).toContain(' time-control="180+2" ')
    expect(parsed.content[1]).toContain(' moves="e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1" times="6000 16000 26000 36000 46000 56000 66000" ')
    expect(parsed.content[1]).toMatch(/ clocks="180000 179000 178000 177000 176000 175000 174000" fog>$/)
    // The game alone: what it is, beyond what the board shows, is in its details.
    expect(parsed.content).toHaveLength(2)
    expect(parsed.details).toEqual([
      ['variant', 'Fog of War'],
      ['speed', 'Blitz'],
      ['clock', '3 | 2'],
      ['minrating', 2000],
      ['players', [{ text: 'ann', url: `${FOG}/archive&p=ann&gameType=2pc&daysBack=0-9999` }, { text: 'bo', url: `${FOG}/archive&p=bo&gameType=2pc&daysBack=0-9999` }]],
      ['ratings', [2100, 2000]],
      ['rating changes', ['+4.5', '−4.5']],
      ['result', '1-0'],
      ['winner', { text: 'ann', url: `${FOG}/archive&p=ann&gameType=2pc&daysBack=0-9999` }],
      ['ending', 'Black resigned'],
      ['moves', 4],
      ['minutes', 2],
      ['mode', 'Rated'],
      ['played', '2026-11-11'],
    ])
    expect(parsed.links.map((link: any) => link.url)).toEqual([
      `${FOG}/leaderboards&speed=blitz`,
      `${FOG}/archive&p=ann&gameType=2pc&daysBack=0-9999`,
      `${FOG}/archive&p=bo&gameType=2pc&daysBack=0-9999`,
    ])
  })

  it('lists a player\'s latest games, newest first', async () => {
    app(`${FOG}/archive&p=Ann&gameType=2pc&daysBack=0-9999`, { archive: { foundGames: [game(3, 'ann', 'bo'), game(2, 'cy', 'ann', 'rapid'), game(1, 'cy', 'dee')], isLastArchivePage: false } })
    const parsed = await parseFogOfWar()
    expect(parsed).toMatchObject({ listing: true, title: 'Ann\'s Fog of War games', canonicalUrl: `${FOG}/archive&p=Ann&gameType=2pc&daysBack=0-9999` })
    // Both games' weaker player is rated 2000.
    expect(parsed.links).toEqual([{ url: `${FOG}/game/3`, score: 1 }, { url: `${FOG}/game/2`, score: 1 / 1.1 }])
    expect(parsed.content[0]).toBe('ann (2100) vs bo (2000), blitz 3 | 2: 1-0')
  })

  it('links a player\'s games by their weaker player\'s rating, doubling every 200 points, a little less the older they are', async () => {
    const rated = (gameNr: number, white: number, black?: number) => ({ ...game(gameNr, 'ann', 'bo'), rating1: white, rating3: black })
    app(`${FOG}/archive&p=ann&gameType=2pc&daysBack=0-9999`, { archive: { foundGames: [rated(4, 2400, 1800), rated(3, 2500, 2400), rated(2, 2200, 2600), rated(1, 2400)], isLastArchivePage: false } })
    const { links } = await parseFogOfWar()
    // 1800 halves the newest; 2400 quadruples the next; 2200 doubles the third; one with no rating counts as 1500.
    expect(links.map((link: any) => [link.url.split('/').pop(), link.score])).toEqual([
      ['4', 0.5],
      ['3', 4 / 1.1],
      ['2', 2 / 1.2],
      ['1', 2 ** -2.5 / 1.3],
    ])
  })

  it('chooses the player of that very name where the page lists players by it and chooses none', async () => {
    vi.useFakeTimers()
    try {
      const archive: any = { foundGames: [], isLastArchivePage: true }
      app(`${FOG}/archive&p=szlive&gameType=2pc&daysBack=0-9999`, { archive })
      document.querySelector('#app')!.innerHTML = ['szlivers', 'szlive', 'szliveson']
        .map(name => `<div class="archive-search-auto-complete-username">${name}  (${name.length})</div>`).join('')
      const chosen: string[] = []
      document.querySelectorAll('.archive-search-auto-complete-username').forEach(choice => choice.addEventListener('click', () => {
        chosen.push(choice.textContent!)
        archive.foundGames = [game(5, 'szlive', 'bo')]
      }))
      const parsed = parseFogOfWar()
      await vi.advanceTimersByTimeAsync(3000)
      expect(chosen).toEqual(['szlive  (6)'])
      expect((await parsed).links.map((link: any) => link.url)).toEqual([`${FOG}/game/5`])
    } finally {
      vi.useRealTimers()
    }
  })

  it('looks further back through a player\'s games for those of one speed, as the page\'s list loads more', async () => {
    const archive: any = { foundGames: [game(9, 'ann', 'bo'), game(8, 'ann', 'bo', 'rapid')], isLastArchivePage: false }
    let page = 0
    archive.incrementPage = vi.fn(() => {
      page++
      archive.foundGames = [...archive.foundGames, game(8 - page, 'ann', 'cy', page === 1 ? 'rapid' : 'blitz')]
      archive.isLastArchivePage = page === 2
    })
    app(`${FOG}/archive&p=ann&gameType=2pc&daysBack=0-9999&speed=rapid`, { archive })
    const parsed = await parseFogOfWar()
    expect(archive.incrementPage).toHaveBeenCalledTimes(2)
    expect(parsed.title).toBe('ann\'s Fog of War rapid games')
    expect(parsed.canonicalUrl).toBe(`${FOG}/archive&p=ann&gameType=2pc&daysBack=0-9999&speed=rapid`)
    expect(parsed.links.map((link: any) => link.url)).toEqual([`${FOG}/game/8`, `${FOG}/game/7`])
  })

  const types = ['blitz', 'rapid'].map(speed => ({ leaderboardType: `rt:fogofwar:${speed}`, name: `Fog Of War ${speed}`, numberOfActivePlayers: 1000 }))

  it('says what it waited for when the site does not send it, before the scrape runs out of time', async () => {
    vi.useFakeTimers()
    try {
      const boards: any = { leaderboardTypes: types, leaderboard: { leaderboardType: 'numGamesTotal', leaders: [{ username: 'ann', rating: 2400 }] }, selectType: vi.fn() }
      app(`${FOG}/leaderboards&speed=rapid`, { leaderboards: boards })
      const parsed = parseFogOfWar().catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(10_000)
      // The speed's tab chosen once, and again when nothing came of it.
      expect(boards.selectType.mock.calls).toEqual([['rt:fogofwar:rapid'], ['rt:fogofwar:rapid']])
      // What it knows of the page is kept, the page being a listing with nothing of its own, and why is given.
      const result: any = await parsed
      expect(result).toMatchObject({ listing: true, title: 'Fog of War Rapid leaderboard', content: [], links: [], canonicalUrl: `${FOG}/leaderboards&speed=rapid` })
      expect(result.failed).toMatch(/did not send its Fog of War rapid leaderboard, showing numGamesTotal \(1 leaders\) in 9 s \(the tab was \w+\)/)

      app(`${FOG}/game/7`, { game: { game: null } })
      const game = parseFogOfWar().catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await game).toMatchObject({ untitled: true, content: [], failed: expect.stringMatching(/did not send game 7 in 9 s/) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('links the leaderboards to each speed\'s', async () => {
    app(`${FOG}/leaderboards`, { leaderboards: { leaderboardTypes: types, leaderboard: { leaderboardType: 'rt:fogofwar:blitz', leaders: [{ username: 'ann', rating: 2400 }] } } })
    const parsed = await parseFogOfWar()
    expect(parsed).toMatchObject({ listing: true, canonicalUrl: `${FOG}/leaderboards` })
    expect(parsed.links.map((link: any) => link.url)).toEqual([`${FOG}/leaderboards&speed=blitz`, `${FOG}/leaderboards&speed=rapid`])
  })

  it('links a speed\'s leaderboard to its leaders\' games of that speed, choosing the page\'s tab for it', async () => {
    const boards: any = { leaderboardTypes: types, leaderboard: { leaderboardType: 'rt:fogofwar:blitz', leaders: [{ username: 'ann', rating: 2400 }] } }
    boards.selectType = vi.fn((type: string) => {
      boards.leaderboard = { leaderboardType: type, leaders: [{ username: 'bo', rating: 2600 }, { username: 'cy', rating: 2500 }] }
    })
    app(`${FOG}/leaderboards&speed=rapid`, { leaderboards: boards })
    const parsed = await parseFogOfWar()
    expect(boards.selectType).toHaveBeenCalledWith('rt:fogofwar:rapid')
    expect(parsed.content).toEqual(['#1 bo 2600', '#2 cy 2500'])
    expect(parsed.links.map((link: any) => link.url)).toEqual([
      `${FOG}/archive&p=bo&gameType=2pc&daysBack=0-9999&speed=rapid`,
      `${FOG}/archive&p=cy&gameType=2pc&daysBack=0-9999&speed=rapid`,
    ])
  })
})
