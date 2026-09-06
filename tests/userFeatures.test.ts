import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('pinned content cannot enter one-item or bulk updates', async () => {
  const installer = await fsp.readFile(path.join(root, 'src/main/content/install.ts'), 'utf8')
  const renderer = await fsp.readFile(path.join(root, 'src/renderer/pages/ProfileDetail.tsx'), 'utf8')
  assert.match(installer, /entry\.pinned/)
  assert.match(renderer, /item\.updateAvailable && !item\.pinned/)
})

test('server join supports quick play and the legacy server argument', async () => {
  const launcher = await fsp.readFile(path.join(root, 'src/main/minecraft/launcher.ts'), 'utf8')
  assert.match(launcher, /quickPlayMultiplayer/)
  assert.match(launcher, /gameArgs\.push\('--server', host\)/)
})

test('automatic world restore preserves the current world and keeps bounded history', async () => {
  const backups = await fsp.readFile(path.join(root, 'src/main/worldBackups.ts'), 'utf8')
  const ipc = await fsp.readFile(path.join(root, 'src/main/ipc.ts'), 'utf8')
  assert.match(backups, /const KEEP_PER_WORLD = 5/)
  assert.match(backups, /await backupWorld\(profile, folder\)/)
  assert.match(backups, /await fsp\.cp\(source, staging/)
  assert.match(backups, /if \(await fsp\.access\(current\).*await backupWorld\(profile, folder\)/)
  assert.match(ipc, /if \(profile\.autoBackupWorlds\)/)
})

test('profile health UI offers scanning and one-click fixes', async () => {
  const renderer = await fsp.readFile(path.join(root, 'src/renderer/pages/ProfileDetail.tsx'), 'utf8')
  const health = await fsp.readFile(path.join(root, 'src/main/profileHealth.ts'), 'utf8')
  assert.match(renderer, /api\.profiles\.health\(profileId\)/)
  assert.match(renderer, /api\.profiles\.fixHealth\(profileId/)
  assert.match(health, /remove-missing-content/)
  assert.match(health, /clear-custom-java/)
  // No invented percentage: the list of issues is the report.
  assert.doesNotMatch(health, /\bscore\b\s*[,:=]/)
  assert.doesNotMatch(renderer, /Sağlık/)
})

test('safe mode, storage manager, history and bulk content controls are wired end to end', async () => {
  const maintenance = await fsp.readFile(path.join(root, 'src/main/profileMaintenance.ts'), 'utf8')
  const preload = await fsp.readFile(path.join(root, 'src/preload/index.ts'), 'utf8')
  const renderer = await fsp.readFile(path.join(root, 'src/renderer/pages/ProfileDetail.tsx'), 'utf8')
  assert.match(maintenance, /enableSafeMode/)
  assert.match(maintenance, /restoreSafeMode/)
  assert.match(maintenance, /cleanProfileStorage/)
  assert.match(maintenance, /recordProfileHistory/)
  assert.match(preload, /content:toggleMany/)
  // Safe mode is a state the profile is left in, so it is offered in the
  // profile's own maintenance section rather than as a second launch button.
  assert.match(renderer, /Güvenli modu aç/)
  assert.doesNotMatch(renderer, /Güvenli başlat/)
  assert.match(renderer, /Değişiklik geçmişi/)
  assert.match(renderer, /Depolama kullanımı/)
  assert.match(renderer, /Güncellemesi olanlar/)
  assert.match(renderer, /Son 7 günde eklenenler/)
})

test('first-run wizard saves a selected play preset', async () => {
  const welcome = await fsp.readFile(path.join(root, 'src/renderer/components/Welcome.tsx'), 'utf8')
  assert.match(welcome, /performance/)
  assert.match(welcome, /balanced/)
  assert.match(welcome, /visuals/)
  assert.match(welcome, /defaultMemoryMb/)
})

/**
 * Adding a second account used to be impossible: the sign-in window shared one
 * persistent cookie jar and never asked which account to use, so Microsoft
 * signed it straight back in as whoever it saw last and redirected before the
 * page was drawn — the window opened and shut itself. Trying again repeated the
 * same silent sign-in until Microsoft answered "too many requests".
 */
test('each sign-in gets its own cookie jar and asks which account', () => {
  const auth = readFileSync('src/main/auth/microsoft.ts', 'utf8')

  assert.doesNotMatch(auth, /persist:msa/)
  assert.match(auth, /const partition = `msa-\$\{randomBytes\(8\)\.toString\('hex'\)\}`/)
  assert.match(auth, /partition\s*\}\s*\n\s*\}\)/)

  // The prompt is set for both platforms, not only the one that uses PKCE.
  const prompt = auth.indexOf("params.set('prompt', 'select_account')")
  assert.ok(prompt > 0)
  assert.ok(prompt > auth.indexOf('if (pkce) {'))
  assert.equal(auth.split("params.set('prompt', 'select_account')").length - 1, 1)
})

test('the profile icon controls stay inside the settings column', () => {
  const css = readFileSync('src/renderer/styles/global.css', 'utf8')
  assert.match(css, /\.settings-row > \*\s*\{\s*min-width:\s*0;/)
  assert.match(css, /\.settings-row__controls\s*\{\s*flex-wrap:\s*wrap;/)

  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  assert.match(detail, /className="row settings-row__controls"/)
})

/**
 * A mod added by hand, imported from a file or inherited from a pack can sit
 * there needing a library nobody installed — Sodium without Fabric API is the
 * usual one. The game then fails at startup naming a mod the player never
 * chose, while the launcher shows everything as correctly installed.
 */
test('missing required libraries can be installed from the profile settings', () => {
  const install = readFileSync('src/main/content/install.ts', 'utf8')

  // Only required dependencies. An optional one is a suggestion the player may
  // decline, and following it would grow the profile on every press.
  assert.match(install, /if \(!dependency\.required \|\| !dependency\.projectId\) continue/)
  // Anything already present is not missing, matched by project id so a copy
  // imported from disk counts too.
  assert.match(install, /for \(const entry of profile\.content\) if \(entry\.projectId\) wanted\.delete\(entry\.projectId\)/)
  // An install can bring its own dependencies, so the loop re-checks.
  assert.match(install, /store\.profile\(profileId\)\?\.content\.some\(\(entry\) => entry\.projectId === projectId\)/)

  // Wired through, and under the rollback transaction.
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  assert.match(ipc, /handle\('content:installMissingDependencies'/)
  assert.match(ipc, /install\.installMissingDependencies\(profileId, onProgress\)/)

  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  assert.match(detail, /api\.content\.installMissingDependencies\(profileId\)/)
  assert.match(detail, /Gerekli kütüphaneler/)
})

/**
 * A hundred-mod pack takes minutes. Waiting for it behind a dialog showed the
 * player nothing and made the launcher look stuck, and the profile only existed
 * once the last jar had landed.
 */
test('a pack profile exists before its mods do, and says what it is doing', () => {
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  const handler = ipc.slice(ipc.indexOf("handle('content:installPack'"))

  // The profile is created and marked, then the install runs unawaited.
  const marked = handler.indexOf('preparing: true')
  const background = handler.indexOf('void (async () => {')
  const install = handler.indexOf('curated.installPackInto')
  assert.ok(marked > 0 && background > marked && install > background)
  // Progress carries the profile so its own page can show it.
  assert.match(handler.slice(0, install + 200), /progressFor\(profile\.id, onProgress\)/)

  // The dialog hands over instead of waiting for a report.
  const dialog = readFileSync('src/renderer/components/PackDialog.tsx', 'utf8')
  // The second argument says a profile was created, which is what separates
  // this path from installing the same pack into one that already exists.
  assert.match(dialog, /onInstalled\(profile\.id, true\)/)
  assert.doesNotMatch(dialog, /PackInstallResult/)

  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  assert.match(detail, /Modlar kuruluyor/)
  assert.match(detail, /tasks\.find\(\(task\) => task\.profileId === profile\.id && task\.state === 'running'\)/)
  // And it cannot be launched half-built. The expression grew a second guard
  // later, so only the preparing half is pinned here.
  assert.match(detail, /disabled=\{profile\.preparing/)
})

/**
 * The drop target used to be only the rows themselves, so a jar dropped into
 * the empty space under a short list landed nowhere — which reads as "drag and
 * drop is broken" rather than "you missed the list".
 */
test('the content tab accepts a file dropped anywhere below the tabs', () => {
  const css = readFileSync('src/renderer/styles/global.css', 'utf8')

  // Scoped to the profile page: turning every page into a flex column would
  // change layouts that have nothing to do with dropping files.
  assert.match(css, /\.page--profile \{\s*display: flex;\s*flex-direction: column;/)
  // Grows into the empty space, but never shrinks a long list.
  assert.match(css, /\.page--profile > \.dropzone \{[\s\S]*?flex: 1 0 auto;/)

  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  assert.match(detail, /className="page page--profile"/)
  assert.match(detail, /onDrop=\{\(event\) => void acceptDrop\(event\)\}/)
})

/**
 * There used to be three lifetimes — 2.4 seconds for a finished task, 3.5 for a
 * notice, 8 for an error — and a failure reported by the main process had none
 * at all, so it sat at the bottom of the window until the launcher was
 * restarted.
 */
test('every finished notice clears itself after the same five seconds', () => {
  const context = readFileSync('src/renderer/state/AppContext.tsx', 'utf8')

  assert.match(context, /const NOTICE_LIFETIME_MS = 5000/)
  // One place decides, and it is the only timeout left.
  assert.equal(context.split('setTimeout(').length - 1, 1)
  assert.doesNotMatch(context, /\b(2400|3500|8000)\b/)

  // An error from the main process is retired too, not only a finished task.
  assert.match(context, /if \(task\.state !== 'running'\) retire\(task\.id, Boolean\(task\.action\)\)/)
  // A notice offering a button waits to be used: one that vanishes mid-click is
  // worse than no button at all.
  assert.match(context, /const retire = useCallback\(\(id: string, keep: boolean\) => \{\s*if \(keep\) return/)
})

/**
 * `sessions` only learns about a launch once it has succeeded, and getting
 * there takes as long as the downloads and the loader's build steps do —
 * minutes on a first run. Pressing Play again inside that window started a
 * second copy of the same profile: two processes writing one world, one
 * options.txt and one mods folder.
 */
test('a profile can only have one launch in flight', () => {
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')

  assert.match(ipc, /handle\(\s*'game:launch',\s*onlyOneLaunch\(/)

  const wrapper = ipc.slice(ipc.indexOf('function onlyOneLaunch'), ipc.indexOf('const pendingOptions'))
  // Claimed before the first await, so two clicks in the same instant cannot
  // both get past the check.
  const claim = wrapper.indexOf('launching.add(profileId)')
  const firstAwait = wrapper.indexOf('await ')
  assert.ok(claim > 0 && firstAwait > claim, 'ilk await’ten önce sahiplenilmeli')
  // Both states are refused: already running, and already on its way.
  assert.match(wrapper, /sessions\.has\(profileId\)/)
  assert.match(wrapper, /launching\.has\(profileId\)/)
  // Released whatever happens, or the profile could never be launched again.
  assert.match(wrapper, /\} finally \{\s*\/\/[\s\S]*?launching\.delete\(profileId\)/)

  // And the button cannot fire twice while the call is out.
  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  assert.match(detail, /disabled=\{profile\.preparing \|\| launching\}/)
  assert.match(detail, /setLaunching\(true\)/)
})

/**
 * A profile played for a season has hundreds of screenshots, and a flat grid of
 * them is a wall. The tab groups them by month, with the current one named
 * rather than dated because that is how people refer to it.
 */
test('screenshots can be searched, sorted and folded away by month', () => {
  // The gallery is shared: the profile's own tab and the launcher-wide page
  // draw the same component, so neither can quietly lose a control.
  const detail = readFileSync('src/renderer/components/ScreenshotGallery.tsx', 'utf8')
  const tab = detail

  // Search, both sort directions, and grouping that can be turned off.
  assert.match(tab, /item\.fileName\.toLocaleLowerCase\(locale\)\.includes\(needle\)/)
  assert.match(tab, /newestFirst \? right\.createdAt - left\.createdAt : left\.createdAt - right\.createdAt/)
  assert.match(tab, /grouped\s*\?\s*groupByMonth\(visible, locale\)/)

  // Each group folds, and says how many it holds.
  assert.match(tab, /aria-expanded=\{!collapsed\.has\(group\.key\)\}/)
  assert.match(tab, /\{group\.items\.length\}/)

  // Month names follow the language the player chose, not a hardcoded locale.
  assert.match(detail, /const locale = currentLanguage\(\)/)
  assert.match(detail, /toLocaleDateString\(locale, \{ month: 'long', year: 'numeric' \}\)/)

  // A search that matches nothing is its own state, not an empty page.
  assert.match(tab, /Eşleşen görüntü yok/)
})

/**
 * The remove button sits next to the on/off switch and deletes the jar from
 * disk. Nothing brings it back but another download, so the click alone must
 * not be enough.
 */
test('removing content asks first', () => {
  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  const tab = detail.slice(detail.indexOf('function ContentTab'), detail.indexOf('function ScreenshotsTab'))

  // The button opens the question instead of doing the deletion.
  assert.match(tab, /onClick=\{\(\) => setPendingRemove\(item\)\}/)
  assert.doesNotMatch(tab, /onClick=\{\(\) => void run\(item\.id, \(\) => api\.content\.remove/)

  // And the confirmation is the one that actually removes it.
  const confirm = tab.slice(tab.indexOf('{pendingRemove && ('))
  assert.match(confirm, /api\.content\.remove\(profileId, target\.id\)/)
  assert.match(confirm, /danger/)
})

/**
 * A pack used to be installable only as a whole new profile, which meant
 * wanting its mods in the world you already play involved building a second
 * profile and moving the saves across.
 */
test('a pack can be added to a profile that already exists', () => {
  const dialog = readFileSync('src/renderer/components/PackDialog.tsx', 'utf8')

  // Only profiles the pack's mods can actually run under are offered.
  assert.match(dialog, /profile\.loader === pack\.loader \|\| \(pack\.loader === 'fabric' && profile\.loader === 'quilt'\)/)
  assert.match(dialog, /\.installPackInto\(pack\.id, into\.id\)/)
  assert.match(dialog, /onInstalled\(into\.id, false\)/)

  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  const handler = ipc.slice(ipc.indexOf("handle('content:installPackInto'"))
  // The profile is the player's, so a failed run is rolled back rather than
  // deleted the way a freshly created one is.
  assert.match(handler.slice(0, 2_000), /withProfileRollback\(/)
  assert.doesNotMatch(handler.slice(0, 2_000), /store\.removeProfile/)
  // And a loader mismatch is refused before anything is downloaded.
  assert.match(handler.slice(0, 2_000), /Paketi yeni bir profil olarak kurun/)
})

/**
 * The gallery sends the pictures themselves across the IPC boundary. PNG data
 * urls made that 48 MB for a folder of 200, and every visit paid the full
 * decode-and-scale again.
 */
test('screenshot thumbnails are JPEG and kept on disk', () => {
  const source = readFileSync('src/main/screenshots.ts', 'utf8')
  assert.match(source, /data:image\/jpeg;base64,/)
  assert.doesNotMatch(source, /toDataURL/)

  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  assert.match(ipc, /\.resize\(\{ width: THUMBNAIL_WIDTH \}\)\.toJPEG\(THUMBNAIL_QUALITY\)/)
  assert.match(ipc, /'\.pisankus', 'cache', 'thumbnails'/)

  // The cache belongs to the category the storage screen can already clear.
  const maintenance = readFileSync('src/main/profileMaintenance.ts', 'utf8')
  assert.match(maintenance, /cache: \[.*'\.pisankus\/cache'\]/)
})

/**
 * Screenshots were reachable only through the profile that took them, which is
 * the wrong way round: what someone wants back is the picture, not the profile
 * it happens to sit under. Playing three profiles meant remembering which one
 * you were in that evening and opening each in turn.
 */
test('screenshots have a page of their own, across every profile', () => {
  const app = readFileSync('src/renderer/App.tsx', 'utf8')
  assert.match(app, /\{ page: 'screenshots', label: 'Ekran görüntüleri', icon: 'image' \}/)
  assert.match(app, /route\.page === 'screenshots' && <Screenshots \/>/)

  const page = readFileSync('src/renderer/pages/Screenshots.tsx', 'utf8')
  // Every profile is read, side by side, and one bad folder does not empty the
  // page.
  // Read through a ref rather than the array in scope, so the reader can stay
  // stable while still seeing the current list.
  assert.match(page, /latest\.current\.map\(async \(profile\) => \{/)
  assert.match(page, /api\.screenshots\.list\(profile\.id\)\.catch\(\(\) => \[\]\)/)
  // Deleting works on the profile the shot came from, not the page's own idea
  // of a current profile.
  assert.match(page, /api\.screenshots\s*\.remove\(item\.profileId, item\.fileName\)/)

  // The card says which profile a shot belongs to when the list spans several.
  const gallery = readFileSync('src/renderer/components/ScreenshotGallery.tsx', 'utf8')
  assert.match(gallery, /item\.profileName \? `\$\{item\.profileName\} · ` : ''/)
})

/**
 * The sidebar's profile list is a shortlist, and it was in whatever order the
 * profiles happened to be stored in — so the one someone plays every evening
 * could sit at the bottom, or past the cut and not be there at all.
 */
test('the sidebar lists the most recently played profiles first', () => {
  const app = readFileSync('src/renderer/App.tsx', 'utf8')
  const recent = app.slice(app.indexOf('const recent = useMemo('), app.indexOf('const runningCount'))

  // The same key the library sorts on, so the two agree about what "recent"
  // means, and a profile never played falls back to when it was made.
  assert.match(
    recent,
    /\(right\.lastPlayed \?\? right\.createdAt\) - \(left\.lastPlayed \?\? left\.createdAt\)/
  )
  // Sorted before the cut: otherwise the shortlist is still the first eight.
  assert.ok(recent.indexOf('.sort(') < recent.indexOf('.slice(0, 8)'))
  // And a copy, since the context's array is shared with every other page.
  assert.match(recent, /\[\.\.\.profiles\]/)
  assert.match(app, /\{recent\.map\(\(profile\) => \{/)
})

/**
 * The gallery shows a 360px thumbnail, which is right for a grid and useless
 * for looking at a picture. Clicking a card used to do nothing at all.
 */
test('a screenshot can be opened at full size', () => {
  const gallery = readFileSync('src/renderer/components/ScreenshotGallery.tsx', 'utf8')
  // The picture itself is the target, not a small icon on it.
  assert.match(gallery, /className="screenshot-card__open"/)
  assert.match(gallery, /onClick=\{\(\) => setOpened\(keyOf\(item\)\)\}/)

  const viewer = readFileSync('src/renderer/components/ScreenshotViewer.tsx', 'utf8')
  // Read when opened, not shipped with the list.
  assert.match(viewer, /api\.screenshots\s*\.read\(item\.profileId, item\.fileName\)/)
  // Arrow keys walk the list; Escape closes.
  assert.match(viewer, /event\.key === 'ArrowRight' && index \+ 1 < items\.length/)
  assert.match(viewer, /event\.key === 'ArrowLeft' && index > 0/)
  assert.match(viewer, /event\.key === 'Escape'/)
  // The thumbnail stands in while the file is read, rather than a blank frame.
  assert.match(viewer, /src=\{full \?\? item\.thumbnail\}/)

  // The full-size read never takes a path from the renderer as given.
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  assert.match(ipc, /resolveInside\(screenshotDir\(profileId\), requireLeafName\(fileName/)
})

/**
 * A pack is a file as often as it is a Modrinth page — exported from another
 * launcher, sent by a friend — and there was no way in for any of them.
 */
test('a modpack can be installed from a .mrpack file', () => {
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  const handler = ipc.slice(ipc.indexOf("handle('content:installMrPackFile'"))

  // The profile is created with what the pack declares, not a placeholder that
  // gets corrected once the files have landed.
  assert.match(handler.slice(0, 1_500), /gameVersion: details\.gameVersion/)
  assert.match(handler.slice(0, 1_500), /loader: details\.loader/)
  // And a failure takes the half-built profile away again.
  assert.match(handler.slice(0, 2_500), /store\.removeProfile\(profile\.id\)/)

  // Pack paths stay inside the profile even if the index is malformed.
  const install = readFileSync('src/main/content/install.ts', 'utf8')
  assert.match(install, /resolveInside\(profile\.directory, file\.path, 'Mod paketi dosya yolu'\)/)
  // A local pack is recorded as local: there is no project to check updates on.
  assert.match(install, /id: `local-pack:\$\{slug\}`, source: 'local'/)
})

/**
 * Ordering by last played is right most of the time and wrong for the one
 * profile someone always wants within reach.
 */
test('a pinned profile stays at the top of the sidebar', () => {
  const app = readFileSync('src/renderer/App.tsx', 'utf8')
  const recent = app.slice(app.indexOf('const recent = useMemo('), app.indexOf('const togglePin'))
  // Checked before the last-played comparison, so it wins over it.
  assert.match(recent, /if \(Boolean\(left\.pinned\) !== Boolean\(right\.pinned\)\) return left\.pinned \? -1 : 1/)
  assert.ok(recent.indexOf('pinned') < recent.indexOf('lastPlayed'))

  // The pin is a sibling of the row, since the row is itself a button.
  assert.match(app, /<div className="nav-profile" key=\{profile\.id\}>/)
  assert.match(app, /aria-pressed=\{profile\.pinned === true\}/)

  // And the main process only accepts it as a boolean.
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  assert.match(ipc, /if \(typeof patch\.pinned === 'boolean'\) allowed\.pinned = patch\.pinned/)
})

/**
 * The context replaces its profiles array on every `profiles:changed` event — a
 * mod installed, a game launched, an icon changed. An effect that depends on
 * the array therefore re-runs on all of them, and this one re-reads every
 * screenshot folder in the launcher, pictures included. Measured at twelve
 * reads where two were needed.
 */
test('the screenshots page re-reads folders only when the profile list changes', () => {
  const page = readFileSync('src/renderer/pages/Screenshots.tsx', 'utf8')

  // A value derived from the list, not the array's identity.
  assert.match(page, /const signature = profiles\.map\(\(profile\) => `\$\{profile\.id\}:\$\{profile\.name\}`\)\.join/)
  assert.match(page, /\}, \[reload, signature\]\)/)
  // The reader itself is stable, so it cannot be what re-triggers the effect.
  assert.match(page, /const reload = useCallback\([\s\S]*?\}, \[\]\)/)
  assert.doesNotMatch(page, /\}, \[profiles\]\)/)
})

/**
 * The download used to start only when the sidebar banner was clicked, so the
 * wait everyone felt as "the update installs slowly" was a hundred-megabyte
 * download that had not begun yet, with nothing on screen saying so.
 */
test('an update downloads as soon as it is found', () => {
  const updater = readFileSync('src/main/updater.ts', 'utf8')
  const available = updater.slice(updater.indexOf("autoUpdater.on('update-available'"))

  // Fetched on discovery, and through the same guarded entry point the button
  // uses so a click cannot start a second download.
  assert.match(available.slice(0, 1_200), /if \(canSelfUpdate\) void downloadUpdate\(\)/)
  assert.doesNotMatch(available.slice(0, 1_200), /autoUpdater\.downloadUpdate\(\)/)

  // macOS cannot install what it downloads, so it is never made to fetch it.
  assert.match(updater, /const canSelfUpdate = process\.platform !== 'darwin'/)

  // Restarting stays the player's call — quitting out from under a running game
  // would be worse than a stale version — but closing the launcher applies it.
  assert.match(updater, /autoUpdater\.autoInstallOnAppQuit = true/)
  assert.match(updater, /if \(status\.state !== 'available'\) return status/)
})

/**
 * `totalPlaytimeMs` answers "how long altogether" and nothing else — not
 * whether those hours were last week or two years ago, nor which of five
 * profiles is the one really being played.
 */
test('play sessions are recorded and can be summarised', () => {
  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  // Written where the running total is, from the same pair of timestamps.
  assert.match(ipc, /totalPlaytimeMs: current\.totalPlaytimeMs \+ \(endedAt - startedAt\)/)
  // The peak goes with it: a session's memory is only readable next to the
  // limit it ran under.
  assert.match(ipc, /void recordSession\(current, startedAt, endedAt, peakMb\)/)
  // One unreadable profile folder must not empty the whole page.
  assert.match(ipc, /sessions: await listSessions\(profile\)\.catch\(\(\) => \[\]\)/)

  const sessions = readFileSync('src/main/playSessions.ts', 'utf8')
  // A launch that fails still produces a process that lived a moment; a chart
  // full of those says the game was played every day it crashed.
  assert.match(sessions, /if \(!Number\.isFinite\(ms\) \|\| ms < MIN_SESSION_MS\) return/)
  // Beside the profile, so exporting or deleting it takes the history along.
  assert.match(sessions, /requireProfileDirectory\(profile\.directory\), '\.pisankus'/)

  const app = readFileSync('src/renderer/App.tsx', 'utf8')
  assert.match(app, /\{ page: 'stats', label: 'İstatistikler', icon: 'chart' \}/)
})

/**
 * Playing the same profile every evening meant opening the launcher, finding it
 * among the others and pressing play.
 */
test('a profile can be started from a desktop shortcut', () => {
  const shortcuts = readFileSync('src/main/shortcuts.ts', 'utf8')
  // One file per platform, each the kind that can carry an argument.
  assert.match(shortcuts, /shell\.writeShortcutLink\(file, 'create'/)
  assert.match(shortcuts, /\.command`\)/)
  assert.match(shortcuts, /\.desktop`\)/)
  // A launcher installed under a path with a space in it is otherwise read as
  // several arguments.
  assert.match(shortcuts, /Exec="\$\{target\}" \$\{argument\}/)
  assert.match(shortcuts, /exec \$\{JSON\.stringify\(target\)\} \$\{JSON\.stringify\(argument\)\}/)
  // A dev run would point the shortcut at a bare Electron.
  assert.match(shortcuts, /if \(!app\.isPackaged\)/)

  const index = readFileSync('src/main/index.ts', 'utf8')
  // Both ways in: the argument the launcher started with, and a shortcut used
  // while it is already running.
  assert.match(index, /requestProfileLaunch\(profileIdFromArgv\(process\.argv\)\)/)
  assert.match(index, /app\.on\('second-instance', \(_event, argv\) => \{/)

  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  // Taken, not read: a page reload must not start the game a second time.
  assert.match(ipc, /handle\('profiles:pendingLaunch', \(\) => takePendingLaunch\(\)\)/)

  const app = readFileSync('src/renderer/App.tsx', 'utf8')
  // The page opens first, so the progress bar and any failure land where the
  // player is already looking.
  const effect = app.slice(app.indexOf('if (!launchRequest) return'))
  assert.ok(effect.indexOf('setRoute(') < effect.indexOf('api.game.launch'))
})

/**
 * A mod count cannot tell ninety-six small tweaks from ninety-six heavy content
 * mods, and the memory each wants is not the same. The running game knows, so
 * it is measured instead of guessed at.
 */
test('memory advice is measured from the game, not counted off the mod list', () => {
  const advice = readFileSync('src/shared/memoryAdvice.ts', 'utf8')
  // Never a count. The fallback is weight on disk, and it says it is a guess.
  assert.doesNotMatch(advice, /modCount/)
  assert.match(advice, /function fromDiskSize\(modBytes: number\)/)
  assert.match(advice, /basis: 'measured' \| 'estimated'/)
  // A peak pressed against its limit says "at least this much", never "enough".
  assert.match(advice, /session\.peakMb < session\.capMb \* PRESSED/)
  assert.match(advice, /Math\.max\(estimate, toStep\(highestCap \+ 1024\)\)/)

  const ipc = readFileSync('src/main/ipc.ts', 'utf8')
  assert.match(ipc, /memoryWatch = watchPeakMemory\(session\.pid\)/)

  const sessions = readFileSync('src/main/playSessions.ts', 'utf8')
  // Both numbers or neither.
  assert.match(sessions, /session\.peakMb = peakMb\s*\n\s*\/\/[\s\S]*?\n\s*session\.capMb = profile\.memoryMb/)

  const detail = readFileSync('src/renderer/pages/ProfileDetail.tsx', 'utf8')
  assert.match(detail, /entry\.category === 'mods'/)
  assert.match(detail, /session\.peakMb && session\.capMb \?/)
})
