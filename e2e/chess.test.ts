import { choose } from '#e2e/choose.ts'
import { expect, test } from '#e2e/fixtures.ts'
import { FOG, GAME, MOVES, archivePage, archiveUrl, chess, fogGame, gamePage, stuckLeaderboardPage } from '../scenarios/chess.ts'

test.describe('chess.com fog of war', () => {
  test('a game is read from the page\'s own app, under its own address, though the page rewrites it', async ({ app, site }) => {
    site.serve(GAME, gamePage())
    await app.scrape(GAME)
    const item = await app.get('items', GAME)
    expect(item.redirectedTo).toBeUndefined()
    expect(item.title).toBe('Zelfmat76 vs szlive')
    expect(item.details).toMatchObject({ speed: 'Blitz', clock: '3 | 2', ratings: [2626, 2434], minrating: 2434, result: '1-0', ending: 'King captured', moves: 14 })
    const links = await app.all('links')
    expect(links.filter((link: any) => link.originKey === GAME).map((link: any) => link.destinationKey).sort()).toEqual([
      `${FOG}/archive&p=Zelfmat76&gameType=2pc&daysBack=0-9999`,
      `${FOG}/archive&p=szlive&gameType=2pc&daysBack=0-9999`,
      `${FOG}/leaderboards&speed=blitz`,
    ])
  })

  test('a page the site does not fill in time is a failed scrape, logged, and still a listing, not a result', async ({ app, site }) => {
    const url = `${FOG}/leaderboards&speed=rapid`
    site.serve(url, stuckLeaderboardPage())
    await app.scrape(url)
    const item = await app.get('items', url)
    expect(item).toMatchObject({ listing: true, scrapeError: true, title: 'Fog of War Rapid leaderboard', content: [] })
    expect(item.timeNextScrape - item.timeLastScraped).toBe(60 * 60 * 1000)
    const logs = (await app.all('logs')).filter((log: any) => log.itemKey === url)
    expect(logs.map((log: any) => log.message)).toContainEqual(expect.stringMatching(/did not send its Fog of War rapid leaderboard, showing numGamesTotal \(1 leaders\) in 9 s/))
  })

  test('a search prefers games between strong players: by the weaker player\'s rating, over how recent they are', async ({ app, site }) => {
    const ann = { name: 'ann', rating: 2400 }
    // The newer game, against a weak player, and an older one against a strong one.
    const newer = fogGame(2, ann, { name: 'bo', rating: 1600 })
    const older = fogGame(1, { name: 'cy', rating: 2300 }, ann)
    site.serve(archiveUrl('ann'), archivePage('ann', [newer, older]))
    site.serve(`${FOG}/game/2`, gamePage(newer))
    site.serve(`${FOG}/game/1`, gamePage(older))
    await app.goToResults(await app.addSearch(archiveUrl('ann'), { maxHops: 1 }))
    const rows = app.page.locator('.dc-table tbody tr')
    await expect(rows).toHaveCount(2, { timeout: 60_000 })
    await expect(rows.first()).toContainText('cy vs ann')
    await expect(rows.last()).toContainText('ann vs bo')
    await expect(app.page.locator('.dc-table thead th', { hasText: 'Minrating' })).toHaveCount(1)
  })

  test('Read plays a game back as it was played, its clocks running, or a move at a time', async ({ app, site }) => {
    await chess.run({ app, site })
    // The page holds the game alone, the board, its players, what they took and their clocks; its moves and the
    // controls that play it are in the side panel, as is what else is known of it.
    const board = app.page.locator('.reader-chess')
    const panel = app.page.locator('.reader-aside .reader-chess-panel')
    await expect(board).toBeVisible()
    await expect(panel).toBeVisible()
    await expect(app.page.locator('.reader-flow p, .reader-flow .reader-post')).toHaveCount(0)
    await expect(app.page.locator('.reader-aside .reader-details')).toContainText('Fog of War')
    await expect(board.locator('.reader-chess-piece')).toHaveCount(32)
    await expect(board.locator('.reader-chess-clock')).toHaveText(['3:00', '3:00'])

    // Stepped to the end, by its key as soon as it is opened, nothing clicked: the king taken, the last move named, the
    // result under the moves.
    await app.page.keyboard.press('End')
    await expect(panel.locator('.reader-chess-move.current')).toHaveText(/^Bxd5/)
    await expect(panel.locator('.reader-chess-result')).toHaveText('1-0 · King captured')
    await expect(board.locator('.reader-chess-piece')).toHaveCount(32 - 10)
    // The game alone fits one page, so the reader has no pages to turn.
    await expect(app.page.locator('.reader-pages')).toHaveCount(0)
    // Each step is heard, a knock's noise played for it, until muted.
    await app.page.evaluate(() => {
      const prototype = AudioContext.prototype as AudioContext & { heard?: number }
      const create = prototype.createBufferSource
      prototype.createBufferSource = function (this: AudioContext) {
        prototype.heard = (prototype.heard ?? 0) + 1
        return create.call(this)
      }
    })
    const heard = () => app.page.evaluate(() => (AudioContext.prototype as AudioContext & { heard?: number }).heard ?? 0)
    await app.page.keyboard.press('ArrowLeft')
    await expect(panel.locator('.reader-chess-move.current')).toHaveText(/^Kxd5/)
    await expect.poll(heard).toBeGreaterThan(0)
    await app.page.keyboard.press('m')
    await expect(panel.getByRole('button', { name: 'Sound on' })).toBeVisible()
    const muted = await heard()
    await app.page.keyboard.press('ArrowLeft')
    await app.page.keyboard.press('ArrowRight')
    await expect(panel.locator('.reader-chess-move.current')).toHaveText(/^Kxd5/)
    expect(await heard()).toBe(muted)
    await panel.getByRole('button', { name: 'Sound on' }).click()
    await board.click({ position: { x: 5, y: 5 } })

    // As played: nothing for the 1.4 s white thought over the first move, white's clock running down meanwhile; then,
    // ten times as fast, the rest.
    await app.page.keyboard.press('Home')
    await panel.getByRole('button', { name: 'Play' }).click()
    await expect(panel.locator('.reader-chess-move.current')).toHaveCount(0)
    await expect(board.locator('.reader-chess-player.bottom .reader-chess-clock.running')).toHaveCount(1)
    await expect(panel.locator('.reader-chess-move.current')).toHaveText(/^e4/, { timeout: 3000 })
    // The bar keeps one length, playing or not, wherever in the game it is.
    const bar = panel.getByRole('slider', { name: 'Moment of the game' })
    const barWidth = async () => (await bar.boundingBox())!.width
    const playingWidth = await barWidth()
    await choose(panel.getByRole('button', { name: 'Speed' }), '10')
    await expect(panel.locator('.reader-chess-move.current')).toHaveText(/^Bxd5/, { timeout: MOVES.reduce((sum, [, thought]) => sum + thought, 0) / 10 + 5000 })
    await expect(panel.getByRole('button', { name: 'Play' })).toBeVisible()
    expect(await barWidth()).toBe(playingWidth)
    await app.page.keyboard.press('Home')
    expect(await barWidth()).toBe(playingWidth)

    // As black saw it: what white's pieces stand on, black could not see, at the start.
    await app.page.keyboard.press('Home')
    await choose(panel.getByRole('button', { name: 'Fog' }), 'b')
    await expect(board.locator('.reader-chess-piece.white')).toHaveCount(0)
    await expect(board.locator('.reader-chess-piece.black')).toHaveCount(16)
    await expect(board.locator('.reader-chess-square.fogged')).toHaveCount(32)
    // Drawn as chess.com draws it: its neo pieces, its squares' colours, and its fog over what is not seen.
    await expect(board.locator('.reader-chess-piece').first()).toHaveAttribute('src', /4e4c4b/)
    await expect(board.locator('.reader-chess-square:not(.dark):not(.fogged)').first()).toHaveCSS('background-color', 'rgb(238, 238, 210)')
    await expect(board.locator('.reader-chess-square.fogged').first()).toHaveCSS('background-image', /fog.*\.png/)
    await board.screenshot({ path: process.env.SCREENSHOT_PATH || 'test-results/chess-fog.png' })
    await app.page.screenshot({ path: 'test-results/chess-read.png' })
  })
})
