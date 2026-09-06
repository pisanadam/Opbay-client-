import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, shell } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type {
  Account,
  CrashReport,
  ContentKind,
  GameLogLine,
  GameState,
  LoaderId,
  Profile,
  ProfileHealthFix,
  ProfileStorageCategory,
  ProjectVersion,
  SearchQuery,
  Settings,
  TaskProgress
} from '../shared/types'
import { reauthError } from '../shared/authErrors'
import { packById } from '../shared/curatedPack'
import { defaultOptionsText, parseOptions, readOption } from '../shared/options'
import * as auth from './auth/microsoft'
import * as curated from './content/curated'
import * as install from './content/install'
import * as modrinth from './content/modrinth'
import { discoverJava } from './minecraft/java'
import { launch, prepareOnly, type GameSession } from './minecraft/launcher'
import {
  detectUnprocessedCrashes,
  GameDiagnostics,
  listCrashReports,
  sanitizeCrashReportForShare
} from './minecraft/crash'
import { listLoaderVersions } from './minecraft/loaders'
import * as servers from './minecraft/servers'
import { listVersions as listGameVersions } from './minecraft/versions'
import {
  listScreenshots as listScreenshotsFrom,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH
} from './screenshots'
import * as skins from './skins'
import { store } from './store'
import * as updater from './updater'
import { changedOptions, writeProfileOptions } from './minecraft/options'
import { requireLeafName, requireProfileDirectory, resolveInside } from './pathSafety'
import * as profileArchive from './profileArchive'
import { withProfileRollback } from './profileTransaction'
import { fixProfileHealth, inspectProfileHealth } from './profileHealth'
import { isNetworkFailure } from './network.ts'
import { ICON_BACKGROUNDS, ICON_SYMBOLS, type IconRecipe } from '../shared/profileIcon'
import { createAutomaticWorldBackups, listAutomaticWorldBackups, restoreAutomaticWorldBackup } from './worldBackups'
import { listSessions, recordSession } from './playSessions'
import { watchPeakMemory } from './processMemory'
import { createProfileShortcut } from './shortcuts'
import {
  cleanProfileStorage,
  enableSafeMode,
  getSafeModeState,
  inspectProfileStorage,
  listProfileHistory,
  recordProfileHistory,
  restoreSafeMode,
  setManyContentEnabled
} from './profileMaintenance'

/** Account shape safe to hand to the renderer — tokens stay in the main process. */
export type PublicAccount = Omit<Account, 'accessToken' | 'refreshToken'> & { expired: boolean }

function toPublic(account: Account): PublicAccount {
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...rest } = account
  return {
    ...rest,
    // Accounts stored before the https fix still hold an http texture url, and
    // upgrading only at sign-in would leave them broken until the next login.
    skinUrl: skins.httpsTexture(rest.skinUrl),
    expired: account.expiresAt <= Date.now()
  }
}

/**
 * Creates a profile with a directory of its own and seeds the configured game
 * options into it. Two profiles may share a name but never a directory —
 * otherwise they would share mods and worlds.
 */
async function createProfile(input: {
  name: string
  gameVersion: string
  loader: LoaderId
  loaderVersion?: string
  icon?: string
}): Promise<Profile> {
  const slug = input.name.replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim() || 'profil'
  const taken = new Set(store.profiles.map((profile) => path.basename(profile.directory)))
  let folder = slug
  let suffix = 2
  while (taken.has(folder)) folder = `${slug}-${suffix++}`

  const profile = store.addProfile({
    name: input.name,
    gameVersion: input.gameVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion,
    icon: input.icon,
    directory: path.join(store.settings.dataDir, 'profiles', folder),
    memoryMb: store.settings.defaultMemoryMb
  })

  // options.txt is deliberately not written here. Minecraft discards any
  // options file with no `version` line, and that number lives inside the
  // client jar, which has not been downloaded yet. The template is seeded on
  // the profile's first launch instead, where the version is known.
  return profile
}

const sessions = new Map<string, GameSession>()

/**
 * Option changes that arrived while the game was already running.
 *
 * Minecraft reads options.txt once, at startup, and writes the whole file back
 * out when it quits. A change saved mid-session is therefore invisible in the
 * running game and then flattened by it on exit — which from the outside looks
 * exactly like "I applied the settings and nothing happened". Holding the text
 * until the process is gone makes the save land on the file the next launch
 * actually reads.
 */
/** Progress that names the profile it belongs to, so its page can show it. */
function progressFor(profileId: string, report: (task: TaskProgress) => void) {
  return (task: TaskProgress): void => report({ ...task, profileId })
}

/**
 * Profiles whose launch has been asked for and has not finished starting.
 *
 * `sessions` only learns about a launch once it has succeeded, and getting there
 * takes as long as the downloads and the loader's own build steps do — minutes
 * on a first run. Pressing Play again inside that window started a second copy
 * of the same profile: two processes writing one world, one options.txt and one
 * mods folder.
 */
const launching = new Set<string>()

/** Lets one launch at a time exist per profile, from the first click onwards. */
function onlyOneLaunch<Rest extends unknown[], Result>(
  run: (profileId: string, ...rest: Rest) => Promise<Result>
): (profileId: string, ...rest: Rest) => Promise<Result> {
  return async (profileId, ...rest) => {
    if (sessions.has(profileId)) throw new Error('Bu profil zaten çalışıyor.')
    // Claimed before the first `await`, so two clicks in the same instant
    // cannot both get past this.
    if (launching.has(profileId)) throw new Error('Bu profil zaten başlatılıyor.')
    launching.add(profileId)

    try {
      return await run(profileId, ...rest)
    } finally {
      // Released once the game has started, not when it exits: from then on the
      // session itself is what says the profile is busy.
      launching.delete(profileId)
    }
  }
}

const pendingOptions = new Map<string, string>()

/**
 * Remembers the keys this save actually changes, so they can be put back before
 * every launch.
 *
 * Only the difference is recorded. The rest of the text the editor sends back is
 * just the file it was shown, and claiming all of it would mean the launcher
 * overwriting settings the player later changes in-game.
 */
async function recordManagedOptions(profileId: string, directory: string, text: string): Promise<void> {
  const file = path.join(directory, 'options.txt')
  const existing = await fsp.readFile(file, 'utf8').catch(() => null)
  // With no file yet there is nothing to compare against, and treating the whole
  // template as a deliberate choice would hand the launcher every key at once.
  if (existing === null) return

  const changed = changedOptions(existing, text)
  const profile = store.profile(profileId)
  const managed = { ...profile?.managedOptions }

  // A key already managed takes the value this save carries, even when that is
  // what the file already said: the player just looked at that number and kept
  // it, so it is their answer now. Without this, setting something back in the
  // editor would leave the launcher stamping the old value at every launch.
  const saved = parseOptions(text)
  for (const key of Object.keys(managed)) {
    const value = readOption(saved, key)
    if (value !== undefined) managed[key] = value
  }
  Object.assign(managed, changed)

  if (Object.keys(managed).length === 0) return
  store.updateProfile(profileId, { managedOptions: managed })
}

/** Writes a deferred save now that the game is no longer holding the file. */
async function flushPendingOptions(profileId: string): Promise<void> {
  const text = pendingOptions.get(profileId)
  if (text === undefined) return
  pendingOptions.delete(profileId)

  const profile = store.profile(profileId)
  if (!profile) return
  await recordManagedOptions(profileId, profile.directory, text).catch(() => undefined)
  await writeProfileOptions(profile.directory, text, true).catch(() => undefined)
}

const launchAborts = new Map<string, AbortController>()

/**
 * Whether the machine has a network at all.
 *
 * Chromium only reports false when it is sure, so a true here still means very
 * little — a captive portal answers this the same way a real connection does.
 * It is a cheap first look; anything it misses is caught when a request
 * actually fails.
 */
function looksOnline(): boolean {
  try {
    return net.isOnline()
  } catch {
    // Called before the app is ready: assume online and let the request decide.
    return true
  }
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  /**
   * The profile a desktop shortcut asked for, if the launcher was started by
   * one. Taken rather than read: it must be acted on once, not on every reload.
   */
  takePendingLaunch: () => string | null = () => null
): void {
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const onProgress = (task: TaskProgress): void => send('task:progress', task)
  /** Tells the renderer to re-read the profile list, without it having to poll. */
  const profilesChanged = (): void => send('profiles:changed', null)
  const onLog = (line: GameLogLine): void => send('game:log', line)
  const onState = (state: GameState): void => send('game:state', state)

  // The renderer draws the update button straight from these.
  updater.initUpdater(
    (status) => send('updates:status', status),
    () => {
      const window = getWindow()
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  )

  /**
   * Runs a skin or cape change, waiting out Mojang's rate limit rather than
   * failing on it. Mojang refuses rapid changes with 429 and the limit is a
   * timed cooldown, so the right answer is to send it again when the wait is
   * over — the way the official launcher does — instead of making the player
   * watch a disabled button.
   */
  async function applyWaitingOutLimit<T>(label: string, run: () => Promise<T>): Promise<T> {
    const taskId = `skin-change-${Date.now()}`

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await run()
        if (attempt > 0) {
          onProgress({ id: taskId, label: `${label} uygulandı`, progress: 1, state: 'done' })
        }
        return result
      } catch (error) {
        // Two waits is plenty; beyond that something else is wrong.
        if (!(error instanceof skins.RateLimitError) || attempt >= 2) throw error

        for (let left = error.retryAfterSeconds; left > 0; left--) {
          onProgress({
            id: taskId,
            label,
            progress: 1 - left / error.retryAfterSeconds,
            detail: `Mojang sınırı: ${left} sn sonra kendiliğinden gönderilecek`,
            state: 'running'
          })
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }
  }

  /** Wraps a handler so thrown errors reach the renderer as readable messages. */
  const handle = <T extends unknown[], R>(
    channel: string,
    handler: (...args: T) => Promise<R> | R
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const window = getWindow()
        if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('Yetkisiz IPC çağrısı reddedildi.')
        }
        return await handler(...(args as T))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Only the message survives the trip to the renderer, so an error that
        // a fresh sign-in would fix has to say so inside its own text.
        throw new Error(
          error instanceof auth.AuthError && error.needsSignIn ? reauthError(message) : message
        )
      }
    })
  }

  // ---------------------------------------------------------------- settings

  handle('settings:get', () => store.settings)
  handle('settings:update', (patch: Partial<Settings>) => store.updateSettings(patch))
  handle('settings:pickDirectory', async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ------------------------------------------------------------------ accounts

  handle('auth:list', () => ({
    accounts: store.accounts.map(toPublic),
    activeId: store.activeAccount?.id
  }))

  handle('auth:signIn', async () => {
    const account = await auth.signIn(store.settings.msClientId, store.settings.authMode)
    store.upsertAccount(account)
    return toPublic(account)
  })

  handle('auth:refresh', async (accountId: string) => {
    const account = store.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('Hesap bulunamadı.')
    const renewed = await auth.refresh(account, store.settings.msClientId)
    store.upsertAccount(renewed)
    return toPublic(renewed)
  })

  handle('auth:setActive', (accountId: string) => {
    store.setActiveAccount(accountId)
    return toPublic(store.activeAccount!)
  })

  handle('auth:remove', (accountId: string) => {
    store.removeAccount(accountId)
    return store.accounts.map(toPublic)
  })

  // ------------------------------------------------------------------ profiles

  handle('profiles:list', () => store.profiles)

  handle('profiles:health', async (id: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    return inspectProfileHealth(profile)
  })

  handle('profiles:healthFix', async (id: string, fix: ProfileHealthFix) => {
    const allowed = new Set<ProfileHealthFix>([
      'create-profile-directory',
      'clear-custom-java',
      'set-safe-memory',
      'remove-missing-content'
    ])
    if (!allowed.has(fix)) throw new Error('Geçersiz profil düzeltme işlemi.')
    const report = await fixProfileHealth(id, fix)
    profilesChanged()
    return report
  })

  /**
   * Picks a picture for a profile and stores it inline.
   *
   * Downscaled to 128px first: the source is whatever the player had lying
   * around, often a multi-megabyte photo, and the icon is never drawn larger
   * than a list row.
   */
  handle('profiles:pickIcon', async (id: string) => {
    const window = getWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Görsel', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const image = nativeImage.createFromPath(result.filePaths[0])
    if (image.isEmpty()) throw new Error('Bu dosya bir görsel olarak okunamadı.')

    const { width, height } = image.getSize()
    const scaled = width > 128 || height > 128 ? image.resize({ width: 128, height: 128 }) : image
    return store.updateProfile(id, { iconImage: scaled.toDataURL() })
  })

  /**
   * Stores an icon drawn by the editor.
   *
   * The picture arrives already rendered, because only the renderer has a canvas
   * — but it is checked here all the same: main is where the database is, and
   * "the renderer sent it" is not a reason to write anything into it.
   */
  handle('profiles:setDrawnIcon', (id: string, dataUrl: string, recipe: IconRecipe) => {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 200_000) {
      throw new Error('Simge görseli okunamadı.')
    }
    if (
      !ICON_BACKGROUNDS.some((entry) => entry.id === recipe?.background) ||
      !ICON_SYMBOLS.some((entry) => entry.id === recipe?.symbol)
    ) {
      throw new Error('Simge seçimi tanınmadı.')
    }
    return store.updateProfile(id, { iconImage: dataUrl, iconRecipe: recipe })
  })

  handle('profiles:clearIcon', (id: string) =>
    store.updateProfile(id, { iconImage: undefined, iconRecipe: undefined })
  )

  /**
   * That profile's own options.txt, read from its folder.
   *
   * Missing means the game has never written one and the launcher's template
   * never reached it either — an empty editor would be a dead end, so the
   * configured template (or Minecraft's defaults) is what gets edited instead.
   */
  handle('profiles:readOptions', async (id: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')

    const file = path.join(profile.directory, 'options.txt')
    const text = await fsp.readFile(file, 'utf8').catch(() => null)
    return {
      text: text ?? (store.settings.minecraftOptions || defaultOptionsText()),
      onDisk: text !== null
    }
  })

  handle('profiles:writeOptions', async (id: string, text: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    if (sessions.has(id)) {
      pendingOptions.set(id, text)
      return { deferred: true }
    }
    await recordManagedOptions(id, profile.directory, text)
    await writeProfileOptions(profile.directory, text, true)
    return { deferred: false }
  })

  /**
   * Hands options.txt back to the game.
   *
   * The launcher stamping a value at every launch is the right default for a
   * setting the player chose here, but it has to be possible to stop — otherwise
   * a setting changed in-game would keep springing back with nothing on screen
   * to explain it.
   */
  handle('profiles:clearManagedOptions', (id: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    store.updateProfile(id, { managedOptions: {} })
    profilesChanged()
    return true
  })

  handle('profiles:create', (input: { name: string; gameVersion: string; loader: LoaderId; loaderVersion?: string; icon?: string }) =>
    createProfile(input)
  )

  handle('profiles:update', async (id: string, patch: Partial<Profile>) => {
    const allowed: Partial<Profile> = {}
    const owns = (key: keyof Profile): boolean => Object.prototype.hasOwnProperty.call(patch, key)
    if (typeof patch.name === 'string') allowed.name = patch.name.slice(0, 120)
    if (typeof patch.memoryMb === 'number' && Number.isFinite(patch.memoryMb)) {
      allowed.memoryMb = Math.max(512, Math.min(65_536, Math.round(patch.memoryMb)))
    }
    if (owns('jvmArgs') && (patch.jvmArgs === undefined || typeof patch.jvmArgs === 'string')) {
      allowed.jvmArgs = patch.jvmArgs?.slice(0, 16_384)
    }
    if (owns('loaderVersion') && (patch.loaderVersion === undefined || typeof patch.loaderVersion === 'string')) {
      allowed.loaderVersion = patch.loaderVersion?.slice(0, 120)
    }
    if (owns('javaPath') && (patch.javaPath === undefined || typeof patch.javaPath === 'string')) {
      allowed.javaPath = patch.javaPath?.trim().slice(0, 4_096) || undefined
    }
    if (owns('resolution')) {
      if (patch.resolution === undefined) {
        allowed.resolution = undefined
      } else if (
        typeof patch.resolution === 'object' &&
        Number.isFinite(patch.resolution.width) &&
        Number.isFinite(patch.resolution.height)
      ) {
        allowed.resolution = {
          width: Math.max(320, Math.min(16_384, Math.round(patch.resolution.width))),
          height: Math.max(240, Math.min(8_640, Math.round(patch.resolution.height)))
        }
      }
    }
    if (typeof patch.autoBackupWorlds === 'boolean') allowed.autoBackupWorlds = patch.autoBackupWorlds
    if (typeof patch.pinned === 'boolean') allowed.pinned = patch.pinned
    const updated = store.updateProfile(id, allowed)
    if (Object.keys(allowed).length > 0) {
      await recordProfileHistory(
        updated,
        'profile-settings',
        'Profil ayarları değiştirildi',
        Object.keys(allowed).join(', ')
      )
    }
    return updated
  })

  handle('profiles:safeMode', async (id: string, enabled?: boolean) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    if (enabled === true) await enableSafeMode(id)
    if (enabled === false) await restoreSafeMode(id)
    profilesChanged()
    return getSafeModeState(store.profile(id)!)
  })

  handle('profiles:history', async (id: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    return listProfileHistory(profile)
  })

  handle('profiles:storage', async (id: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    return inspectProfileStorage(profile)
  })

  handle('profiles:cleanStorage', async (id: string, categories: ProfileStorageCategory[]) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    if (!Array.isArray(categories) || categories.length > 3) throw new Error('Geçersiz temizlik isteği.')
    return cleanProfileStorage(profile, categories, (target) => shell.trashItem(target))
  })

  handle('profiles:duplicate', async (id: string) => {
    const source = store.profile(id)
    if (!source) throw new Error('Profil bulunamadı.')

    const copy = store.addProfile({
      ...source,
      name: `${source.name} (kopya)`,
      directory: path.join(store.settings.dataDir, 'profiles', `${path.basename(source.directory)}-kopya-${Date.now()}`)
    })
    await fsp.cp(source.directory, copy.directory, { recursive: true })
    return store.updateProfile(copy.id, { content: structuredClone(source.content) })
  })

  handle('profiles:delete', async (id: string, deleteFiles: boolean) => {
    const profile = store.profile(id)
    if (profile && deleteFiles) {
      await fsp.rm(requireProfileDirectory(profile.directory), { recursive: true, force: true })
    }
    store.removeProfile(id)
    return store.profiles
  })

  handle('profiles:openFolder', async (id: string) => {
    const profile = store.profile(id)
    if (!profile) throw new Error('Profil bulunamadı.')
    await fsp.mkdir(profile.directory, { recursive: true })
    await shell.openPath(profile.directory)
  })

  handle('profiles:export', async (id: string) => {
    const window = getWindow()
    const profile = store.profile(id)
    if (!window) throw new Error('Pencere bulunamadı.')
    if (!profile) throw new Error('Profil bulunamadı.')
    return profileArchive.exportProfile(window, profile)
  })

  handle('profiles:import', async () => {
    const window = getWindow()
    if (!window) throw new Error('Pencere bulunamadı.')
    const profile = await profileArchive.importProfile(window)
    if (profile) profilesChanged()
    return profile
  })

  // ------------------------------------------------------------------ versions

  handle('versions:list', () => listGameVersions())
  handle('versions:loaders', (loader: LoaderId, gameVersion: string) => listLoaderVersions(loader, gameVersion))
  handle('java:discover', () => discoverJava(store.settings.dataDir))

  // ---------------------------------------------------------------------- game

  handle(
    'game:launch',
    onlyOneLaunch(async (profileId: string, options?: { offline?: boolean; serverAddress?: string }) => {
    // A save made during the last session is written before the game reads the
    // file, not after — if the launcher was closed before the game exited, this
    // is the only place left to apply it.
    await flushPendingOptions(profileId)

    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')

    const account = store.activeAccount
    if (!account) {
      throw new Error(
        options?.offline
          ? 'Çevrimdışı başlatma için bu bilgisayarda daha önce giriş yapılmış bir hesap gerekiyor.'
          : 'Oyunu başlatmak için Microsoft hesabınızla oturum açmanız gerekiyor.'
      )
    }

    /**
     * Offline is no longer something the player picks.
     *
     * There used to be a second launch button for it, which asked them to
     * diagnose their own network before pressing anything. The launcher can see
     * that for itself: no network means an offline launch, and that is the only
     * thing the button ever did.
     */
    let offline = options?.offline === true || !looksOnline()
    const serverAddress = options?.serverAddress?.trim()
    if (serverAddress && (serverAddress.length > 255 || /[\s\0]/.test(serverAddress))) {
      throw new Error('Sunucu adresi geçersiz.')
    }
    if (profile.autoBackupWorlds) {
      onProgress({ id: `world-backup-${profileId}`, label: 'Dünyalar yedekleniyor', progress: -1, state: 'running' })
      const count = await createAutomaticWorldBackups(profile)
      onProgress({
        id: `world-backup-${profileId}`,
        label: count > 0 ? `${count} dünya yedeklendi` : 'Yedeklenecek dünya yok',
        progress: 1,
        state: 'done'
      })
    }
    const diagnostics = new GameDiagnostics(structuredClone(profile))
    const recordedLog = (line: GameLogLine): void => {
      diagnostics.record(line)
      onLog(line)
    }
    const recordLauncherError = (error: unknown): void => {
      recordedLog({
        profileId,
        stream: 'launcher',
        line: `Başlatma başarısız: ${error instanceof Error ? error.message : String(error)}`,
        at: Date.now()
      })
    }
    const publishCrash = (report: CrashReport | null): void => {
      if (report) send('crash:created', report)
    }
    const finishDiagnostics = (state: GameState): void => {
      void diagnostics.finish(state).then(publishCrash).catch(() => undefined)
    }

    // What the jars in `mods/` say about themselves, before the game gets a
    // chance to refuse them. Not a refusal of its own: the player may know
    // something the manifests do not, and a launcher that will not start the
    // game over a warning is worse than one that says so and starts it.
    for (const issue of (await inspectProfileHealth(profile).catch(() => null))?.issues ?? []) {
      if (issue.severity !== 'error' || !issue.id.startsWith('mod-') && issue.id !== 'duplicate-mod-ids') continue
      recordedLog({
        profileId,
        stream: 'launcher',
        line: `Uyarı — ${issue.title}: ${issue.detail}`,
        at: Date.now()
      })
    }

    if (offline) {
      recordedLog({
        profileId,
        stream: 'launcher',
        line: 'Ağa ulaşılamadı; çevrimdışı başlatılıyor.',
        at: Date.now()
      })
    }

    let valid = account
    if (!offline) {
      try {
        valid = await auth.ensureValid(account, store.settings.msClientId)
        if (valid !== account) store.upsertAccount(valid)
      } catch (error) {
        // A refused token is a refusal and must still be reported: starting the
        // game without a session would turn a fixable sign-in problem into one
        // that only shows up as "cannot join any server". Only an unreachable
        // network becomes an offline launch.
        if (!isNetworkFailure(error)) {
          recordLauncherError(error)
          const state: GameState = { profileId, status: 'crashed' }
          onState(state)
          finishDiagnostics(state)
          throw error
        }
        offline = true
        recordedLog({
          profileId,
          stream: 'launcher',
          line: 'Oturum yenilenemedi (ağ yok); çevrimdışı başlatılıyor.',
          at: Date.now()
        })
      }
    }

    const controller = new AbortController()
    launchAborts.set(profileId, controller)
    const startedAt = Date.now()
    let terminal = false
    /**
     * Watches how much memory the game actually takes.
     *
     * What a profile needs cannot be read off its mod list — ninety-six small
     * utility mods and ninety-six heavy ones are not the same pack, and nothing
     * on disk says which is which. The running game does, so it is measured
     * rather than guessed at, and the memory advice uses the measurement once
     * there is one.
     */
    let memoryWatch: { stop: () => number | null } | null = null

    try {
      const session = await launch({
        profile,
        account: valid,
        settings: store.settings,
        onProgress,
        onLog: recordedLog,
        onState: (state) => {
          if (state.status === 'running') diagnostics.markRunning()
          if ((state.status === 'exited' || state.status === 'crashed') && !terminal) {
            terminal = true
            sessions.delete(profileId)
            launchAborts.delete(profileId)
            void flushPendingOptions(profileId)
            const peakMb = memoryWatch?.stop() ?? null
            memoryWatch = null
            const current = store.profile(profileId)
            if (current) {
              const endedAt = Date.now()
              store.updateProfile(profileId, {
                totalPlaytimeMs: current.totalPlaytimeMs + (endedAt - startedAt)
              })
              // The running total cannot say when any of it happened. The
              // session list can, and it is what the statistics are drawn from.
              void recordSession(current, startedAt, endedAt, peakMb).catch(() => undefined)
            }
            finishDiagnostics(state)
          }
          onState(state)
        },
        onRuntimeReady: (runtime) => diagnostics.setRuntime(runtime),
        offline,
        serverAddress,
        signal: controller.signal
      })

      if (!terminal) sessions.set(profileId, session)
      if (!terminal && session.pid !== undefined) memoryWatch = watchPeakMemory(session.pid)
      store.updateProfile(profileId, { lastPlayed: Date.now() })
      return { pid: session.pid }
    } catch (error) {
      launchAborts.delete(profileId)
      if (!terminal) {
        terminal = true
        recordLauncherError(error)
        const state: GameState = { profileId, status: 'crashed' }
        onState(state)
        finishDiagnostics(state)
      }
      if (controller.signal.aborted) return { pid: undefined }
      throw error
    }
    })
  )

  handle('game:kill', (profileId: string) => {
    sessions.get(profileId)?.kill()
    launchAborts.get(profileId)?.abort()
    return true
  })

  handle('game:running', () => [...sessions.keys()])

  handle('game:prepare', async (profileId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    const controller = new AbortController()
    launchAborts.set(`prepare-${profileId}`, controller)
    try {
      await prepareOnly(profile, store.settings, onProgress, controller.signal)
      return true
    } finally {
      launchAborts.delete(`prepare-${profileId}`)
    }
  })

  handle('crashes:list', (profileId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    return listCrashReports(profile)
  })

  handle('crashes:detectPending', async () => {
    const reports = await Promise.all(store.profiles.map((profile) => detectUnprocessedCrashes(profile)))
    return reports.flat().sort((left, right) => right.createdAt - left.createdAt)
  })

  handle('crashes:share', async (profileId: string, reportId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    const report = (await listCrashReports(profile)).find((candidate) => candidate.id === reportId)
    if (!report) throw new Error('Crash raporu bulunamadı.')
    return JSON.stringify(sanitizeCrashReportForShare(report, profile.directory), null, 2)
  })

  handle('crashes:openFolder', async (profileId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    const directory = path.join(profile.directory, 'crash-reports')
    await fsp.mkdir(directory, { recursive: true })
    await shell.openPath(directory)
  })

  // ------------------------------------------------------------------- content

  handle('content:search', (query: SearchQuery) => modrinth.search(query))
  handle('content:userProjects', (username: string) => modrinth.listUserProjects(username))

  handle(
    'content:versions',
    (projectId: string, gameVersion?: string, loader?: LoaderId): Promise<ProjectVersion[]> =>
      modrinth.listVersions(projectId, gameVersion, loader)
  )

  handle('content:project', (projectId: string) => modrinth.getProject(projectId))

  handle('content:install', async (request: install.InstallRequest) => {
    const result = await withProfileRollback(
      request.profileId,
      request.name,
      () => install.installContent(request, onProgress),
      onProgress
    )
    const profile = store.profile(request.profileId)
    if (profile) await recordProfileHistory(profile, 'content-installed', `${request.name} kuruldu`)
    return result
  })
  handle('content:remove', async (profileId: string, contentId: string) => {
    const profile = store.profile(profileId)
    const entry = profile?.content.find((item) => item.id === contentId)
    await install.removeContent(profileId, contentId)
    if (profile && entry) await recordProfileHistory(profile, 'content-removed', `${entry.name} kaldırıldı`, undefined, contentId)
  })
  handle('content:toggle', async (profileId: string, contentId: string, enabled: boolean) => {
    const entry = await install.setContentEnabled(profileId, contentId, enabled)
    const profile = store.profile(profileId)
    if (profile) {
      await recordProfileHistory(
        profile,
        enabled ? 'content-enabled' : 'content-disabled',
        enabled ? `${entry.name} etkinleştirildi` : `${entry.name} devre dışı bırakıldı`,
        undefined,
        contentId
      )
    }
    return entry
  })
  handle('content:toggleMany', async (profileId: string, contentIds: string[], enabled: boolean) => {
    if (!Array.isArray(contentIds) || contentIds.length > 1_000) throw new Error('Geçersiz toplu işlem.')
    await setManyContentEnabled(profileId, contentIds, enabled)
    profilesChanged()
    return store.profile(profileId)?.content ?? []
  })
  handle('content:pin', (profileId: string, contentId: string, pinned: boolean) =>
    install.setContentPinned(profileId, contentId, pinned)
  )
  handle('content:update', async (profileId: string, contentId: string) => {
    const before = store.profile(profileId)?.content.find((item) => item.id === contentId)
    const result = await withProfileRollback(
      profileId,
      'İçerik güncellemesi',
      () => install.updateContent(profileId, contentId, onProgress),
      onProgress
    )
    const profile = store.profile(profileId)
    if (profile && before) await recordProfileHistory(profile, 'content-updated', `${before.name} güncellendi`, undefined, contentId)
    return result
  })
  handle('content:checkUpdates', (profileId: string) => install.checkForUpdates(profileId))

  /** Reconciles the recorded content list with what is really in the folders. */
  handle('content:sync', (profileId: string) => install.syncProfileContent(profileId))

  /**
   * Files dropped onto the profile. The kind is worked out per file from the
   * archive itself, so a world, a resource pack and a shader pack can be
   * dropped together and each still lands in the right folder.
   */
  handle('content:importPaths', async (profileId: string, filePaths: string[]) => {
    const result = await withProfileRollback(
      profileId,
      `${filePaths.length} yerel dosya`,
      async () => {
        for (const filePath of filePaths) {
          const kind = await install.inferKind(filePath)
          await install.importLocalFile(profileId, filePath, kind)
        }
        return store.profile(profileId)?.content ?? []
      },
      onProgress
    )
    const profile = store.profile(profileId)
    if (profile && filePaths.length > 0) {
      await recordProfileHistory(profile, 'content-installed', `${filePaths.length} yerel içerik eklendi`)
    }
    return result
  })

  handle('content:import', async (profileId: string, kind: ContentKind) => {
    const window = getWindow()
    if (!window) return []

    const filters =
      kind === 'world'
        ? [{ name: 'Dünya arşivi', extensions: ['zip'] }]
        : kind === 'mod'
          ? [{ name: 'Mod', extensions: ['jar'] }]
          : [{ name: 'Paket', extensions: ['zip'] }]

    const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters })
    if (result.canceled) return []

    const imported = await withProfileRollback(
      profileId,
      `${result.filePaths.length} yerel dosya`,
      async () => {
        const imported = []
        for (const filePath of result.filePaths) {
          imported.push(await install.importLocalFile(profileId, filePath, kind))
        }
        return imported
      },
      onProgress
    )
    const profile = store.profile(profileId)
    if (profile && imported.length > 0) {
      await recordProfileHistory(profile, 'content-installed', `${imported.length} yerel içerik eklendi`)
    }
    return imported
  })

  handle('worlds:list', (profileId: string) => install.listWorlds(profileId))

  handle('worlds:delete', async (profileId: string, folderName: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    const saves = path.join(profile.directory, 'saves')
    await fsp.rm(resolveInside(saves, requireLeafName(folderName, 'Dünya klasörü')), {
      recursive: true,
      force: true
    })
    return install.listWorlds(profileId)
  })

  handle('worlds:export', async (profileId: string, folderName: string, displayName: string) => {
    const window = getWindow()
    const profile = store.profile(profileId)
    if (!window) throw new Error('Pencere bulunamadı.')
    if (!profile) throw new Error('Profil bulunamadı.')
    return profileArchive.exportWorld(window, profile, folderName, displayName)
  })

  handle('worlds:importBackup', async (profileId: string) => {
    const window = getWindow()
    const profile = store.profile(profileId)
    if (!window) throw new Error('Pencere bulunamadı.')
    if (!profile) throw new Error('Profil bulunamadı.')
    return withProfileRollback(
      profileId,
      'Dünya yedeği',
      () => profileArchive.importWorld(window, profile),
      onProgress
    )
  })

  handle('worlds:autoBackups', async (profileId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    return listAutomaticWorldBackups(profile)
  })
  handle('worlds:restoreAutoBackup', async (profileId: string, folderName: string, backupId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    await restoreAutomaticWorldBackup(profile, folderName, backupId)
    return install.listWorlds(profileId)
  })
  handle('worlds:openAutoBackups', async (profileId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    const directory = path.join(profile.directory, '.pisankus', 'world-backups')
    await fsp.mkdir(directory, { recursive: true })
    await shell.openPath(directory)
  })

  // ---------------------------------------------------------------- shortcuts

  /**
   * Writes a desktop shortcut that starts this profile.
   *
   * The window is told the path afterwards so the message can name where the
   * file landed — on a desktop full of icons, "created" alone is not an answer
   * to "where".
   */
  handle('profiles:createShortcut', async (profileId: string) => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    return createProfileShortcut(profile)
  })

  /** Whether a shortcut can be written at all on this platform and build. */
  handle('profiles:canCreateShortcut', () => app.isPackaged)

  /**
   * The profile a shortcut asked for, collected once by the renderer when it
   * has loaded. Answering null afterwards is what keeps a page reload from
   * starting the game again.
   */
  handle('profiles:pendingLaunch', () => takePendingLaunch())

  // --------------------------------------------------------------- statistics

  /**
   * Every profile's play history, for the statistics page.
   *
   * The sessions are handed over raw and summarised in the renderer: which
   * window is being looked at is the page's business, and a profile deleted
   * since the last visit simply is not in the list.
   */
  handle('stats:sessions', async () =>
    Promise.all(
      store.profiles.map(async (profile) => ({
        profileId: profile.id,
        profileName: profile.name,
        // One unreadable profile folder must not empty the whole page.
        sessions: await listSessions(profile).catch(() => [])
      }))
    )
  )

  // --------------------------------------------------------------- screenshots

  const screenshotDir = (profileId: string): string => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    return path.join(profile.directory, 'screenshots')
  }

  const thumbnailCacheDir = (profileId: string): string => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    return path.join(profile.directory, '.pisankus', 'cache', 'thumbnails')
  }

  const encodeThumbnail = async (file: string): Promise<Buffer | null> => {
    const source = nativeImage.createFromPath(file)
    if (source.isEmpty()) return null
    return source.resize({ width: THUMBNAIL_WIDTH }).toJPEG(THUMBNAIL_QUALITY)
  }

  const listScreenshots = (profileId: string) =>
    listScreenshotsFrom(screenshotDir(profileId), thumbnailCacheDir(profileId), encodeThumbnail)

  handle('screenshots:list', (profileId: string) => listScreenshots(profileId))
  handle('screenshots:openFolder', async (profileId: string) => {
    const directory = screenshotDir(profileId)
    await fsp.mkdir(directory, { recursive: true })
    await shell.openPath(directory)
  })
  /** One screenshot's own bytes, for the full-size view. */
  const screenshotFile = (profileId: string, fileName: string): string =>
    resolveInside(screenshotDir(profileId), requireLeafName(fileName, 'Ekran görüntüsü'))

  /**
   * The picture at full size, as a data url.
   *
   * Read on demand rather than sent with the list: a folder of these is tens of
   * megabytes, and the viewer only ever shows one at a time. The bytes go over
   * as they are on disk, so what the viewer shows is the file itself rather
   * than something re-encoded on the way.
   */
  handle('screenshots:read', async (profileId: string, fileName: string) => {
    const file = screenshotFile(profileId, fileName)
    const bytes = await fsp.readFile(file)
    const type = /\.png$/i.test(fileName) ? 'image/png' : 'image/jpeg'
    return `data:${type};base64,${bytes.toString('base64')}`
  })

  /** Puts the picture on the clipboard, so it can be pasted straight into chat. */
  handle('screenshots:copy', async (profileId: string, fileName: string) => {
    const image = nativeImage.createFromPath(screenshotFile(profileId, fileName))
    if (image.isEmpty()) throw new Error('Bu dosya bir görüntü olarak okunamadı.')
    clipboard.writeImage(image)
  })

  /** Opens the folder with this one file selected, rather than just the folder. */
  handle('screenshots:reveal', (profileId: string, fileName: string) => {
    shell.showItemInFolder(screenshotFile(profileId, fileName))
  })

  handle('screenshots:delete', async (profileId: string, fileName: string) => {
    const directory = screenshotDir(profileId)
    await fsp.rm(resolveInside(directory, requireLeafName(fileName, 'Ekran görüntüsü')), { force: true })
    return listScreenshots(profileId)
  })

  // --------------------------------------------------------------------- skins

  /** Skin calls always run against a freshly refreshed token. */
  const withAccount = async <R>(accountId: string, action: (account: Account) => Promise<R>): Promise<R> => {
    const account = store.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('Hesap bulunamadı.')
    const valid = await auth.ensureValid(account, store.settings.msClientId)
    if (valid !== account) store.upsertAccount(valid)
    return action(valid)
  }

  handle('skins:get', (accountId: string) => withAccount(accountId, skins.getSkinInfo))

  // Picking and applying are separate steps so the chosen file can be previewed
  // on the model first — uploading straight from the file dialog gave no way to
  // see what you were about to put on your account.
  handle('skins:pickFile', async () => {
    const window = getWindow()
    if (!window) throw new Error('Pencere bulunamadı.')
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Skin (PNG)', extensions: ['png'] }]
    })
    if (result.canceled) return null
    return skins.readLocalSkin(result.filePaths[0])
  })

  handle('skins:upload', async (accountId: string, filePath: string, variant: skins.SkinVariant) =>
    withAccount(accountId, async (account) =>
      applyWaitingOutLimit('Skin uygulanıyor', async () => {
        const info = await skins.uploadSkin(account, filePath, variant)
        store.upsertAccount({ ...account, skinUrl: info.skinUrl })
        return info
      })
    )
  )

  handle('skins:setUrl', (accountId: string, url: string, variant: skins.SkinVariant) =>
    withAccount(accountId, async (account) =>
      applyWaitingOutLimit('Skin uygulanıyor', async () => {
        const info = await skins.setSkinFromUrl(account, url, variant)
        store.upsertAccount({ ...account, skinUrl: info.skinUrl })
        return info
      })
    )
  )

  handle('skins:reset', (accountId: string) =>
    withAccount(accountId, async (account) => {
      const info = await skins.resetSkin(account)
      store.upsertAccount({ ...account, skinUrl: info.skinUrl })
      return info
    })
  )

  handle('skins:setCape', (accountId: string, capeId: string | null) =>
    withAccount(accountId, async (account) => {
      const info = await skins.setCape(account, capeId)
      store.upsertAccount({ ...account, capeId: capeId ?? undefined })
      return info
    })
  )

  // ----------------------------------------------------------------------- app

  /**
   * Installs a modpack into a profile of its own.
   *
   * The pack decides its game version and loader, so the profile starts as a
   * placeholder and `applyMrPack` corrects it while unpacking. If anything
   * fails, the half-made profile is removed rather than left in the library.
   */
  /**
   * Creates the profile straight away and downloads into it in the background.
   *
   * A big pack takes minutes. Waiting for it with the dialog open told the
   * player nothing and made the launcher look stuck, so the profile now appears
   * immediately — carrying the pack's name and marked as preparing — and the
   * download reports itself through the task tray.
   */
  handle('content:installModpackAsProfile', async (request: {
    projectId: string
    versionId?: string
    name: string
    iconUrl?: string
  }) => {
    const profile = await createProfile({
      name: request.name,
      gameVersion: 'bilinmiyor',
      loader: 'vanilla',
      icon: '📦'
    })
    store.updateProfile(profile.id, { preparing: true })
    profilesChanged()

    // Deliberately not awaited: the handler answers as soon as the profile
    // exists. Everything after this point reports through onProgress, and a
    // failure removes the profile again rather than leaving an empty one.
    void (async () => {
      try {
        await install.installContent(
          { profileId: profile.id, projectId: request.projectId, versionId: request.versionId,
            kind: 'modpack', name: request.name, iconUrl: request.iconUrl, anyVersion: true },
          progressFor(profile.id, onProgress)
        )
        store.updateProfile(profile.id, { preparing: false })
      } catch (error) {
        store.removeProfile(profile.id)
        await fsp.rm(profile.directory, { recursive: true, force: true }).catch(() => undefined)
        onProgress({
          id: `install-${request.projectId}`,
          label: `${request.name} kurulamadı`,
          progress: 0,
          state: 'error',
          profileId: profile.id,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        profilesChanged()
      }
    })()

    return store.profile(profile.id)!
  })

  /**
   * Opens a `.mrpack` the player already has and says what is in it.
   *
   * Separate from installing it so the dialog can show the pack's real name,
   * Minecraft version, loader and file count before a profile exists — picking
   * a file and having a profile appear unannounced is the wrong order.
   */
  handle('content:pickMrPack', async () => {
    const window = getWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Modrinth mod paketi', extensions: ['mrpack'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    return { filePath, ...(await install.readMrPackFile(filePath)) }
  })

  /**
   * Builds a profile from a `.mrpack` file on disk.
   *
   * The profile is created with what the pack itself declares, so it is right
   * from the first second rather than a placeholder corrected at the end. As
   * with the Modrinth path, the handler answers as soon as the profile exists
   * and a failure removes it again — a half-unpacked pack looks finished from
   * the outside.
   */
  handle('content:installMrPackFile', async (request: { filePath: string; name?: string }) => {
    const details = await install.readMrPackFile(request.filePath)
    const loaderVersion =
      details.loaderVersion ??
      (details.loader === 'vanilla'
        ? undefined
        : (await listLoaderVersions(details.loader, details.gameVersion))[0]?.version)

    const profile = await createProfile({
      name: request.name?.trim() || details.name,
      gameVersion: details.gameVersion,
      loader: details.loader,
      loaderVersion,
      icon: '📦'
    })
    store.updateProfile(profile.id, { preparing: true })
    profilesChanged()

    void (async () => {
      try {
        await install.installMrPackFile(profile.id, request.filePath, progressFor(profile.id, onProgress))
        store.updateProfile(profile.id, { preparing: false })
        await recordProfileHistory(
          store.profile(profile.id)!,
          'content-installed',
          `${details.name} dosyadan kuruldu`,
          path.basename(request.filePath)
        )
      } catch (error) {
        store.removeProfile(profile.id)
        await fsp.rm(profile.directory, { recursive: true, force: true }).catch(() => undefined)
        onProgress({
          id: `mrpack-${profile.id}`,
          label: `${details.name} kurulamadı`,
          progress: 0,
          state: 'error',
          profileId: profile.id,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        profilesChanged()
      }
    })()

    return store.profile(profile.id)!
  })

  // --------------------------------------------------------- curated pack

  handle('content:packVersions', (packId: string) => curated.packVersions(packId))

  /**
   * Builds a whole profile from one of the launcher's packs: the loader the
   * pack asks for on the chosen version, then its curated mods.
   *
   * The profile appears before any of it is downloaded, marked as preparing.
   * A hundred-mod pack takes minutes, and waiting for it behind a dialog told
   * the player nothing and made the launcher look stuck — now the profile is in
   * the library from the first second, and opening it shows what is being
   * installed. A failure removes it again, since a half-built profile would look
   * finished from the outside.
   */
  handle('content:installPack', async (request: { packId: string; gameVersion: string; name: string }) => {
    const pack = packById(request.packId)
    if (!pack) throw new Error(`Paket bulunamadı: ${request.packId}`)

    const loaderVersion = (await listLoaderVersions(pack.loader, request.gameVersion))[0]?.version
    if (!loaderVersion) {
      throw new Error(`${pack.loader} bu Minecraft sürümünü desteklemiyor: ${request.gameVersion}`)
    }

    const profile = await createProfile({
      name: request.name,
      gameVersion: request.gameVersion,
      loader: pack.loader,
      loaderVersion,
      icon: pack.icon
    })
    store.updateProfile(profile.id, { preparing: true })
    profilesChanged()

    // Deliberately not awaited: the handler answers as soon as the profile
    // exists. Everything after this reports through onProgress.
    void (async () => {
      try {
        await curated.installPackInto(pack.id, profile.id, progressFor(profile.id, onProgress))
        store.updateProfile(profile.id, { preparing: false })
      } catch (error) {
        store.removeProfile(profile.id)
        await fsp.rm(profile.directory, { recursive: true, force: true }).catch(() => undefined)
        onProgress({
          id: `pack-${profile.id}`,
          label: `${pack.name} kurulamadı`,
          progress: 0,
          state: 'error',
          profileId: profile.id,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        profilesChanged()
      }
    })()

    return store.profile(profile.id)!
  })

  /**
   * Adds a pack's mods to a profile that already exists.
   *
   * The packs used to be installable only as a whole new profile, which meant
   * anyone who wanted the performance mods in the world they already play had to
   * build a second profile and move their saves across. Here the profile keeps
   * its version, its loader, its worlds and everything already installed; the
   * pack is resolved against that profile's Minecraft version and only the mods
   * are added.
   *
   * Under the rollback transaction, because this profile is the player's: a run
   * that stops halfway must leave the mods folder as it found it rather than
   * being deleted the way a freshly created one is.
   */
  handle('content:installPackInto', async (packId: string, profileId: string) => {
    const pack = packById(packId)
    if (!pack) throw new Error(`Paket bulunamadı: ${packId}`)
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')

    // Fabric mods do run under Quilt, and nothing else mixes: a Fabric jar in a
    // Forge profile is not a mod the game ignores, it is a game that will not
    // start.
    const compatible =
      profile.loader === pack.loader || (pack.loader === 'fabric' && profile.loader === 'quilt')
    if (!compatible) {
      throw new Error(
        `${pack.name} ${pack.loader} paketidir; bu profil ${profile.loader} kullanıyor. ` +
          'Paketi yeni bir profil olarak kurun.'
      )
    }

    return withProfileRollback(
      profileId,
      pack.name,
      async () => {
        await curated.installPackInto(pack.id, profileId, progressFor(profileId, onProgress))
        profilesChanged()
        return store.profile(profileId)!
      },
      onProgress
    )
  })

  /**
   * Installs the libraries the profile's mods declare and do not have.
   *
   * Under the rollback transaction like every other write into a profile: this
   * one can add several jars, and a run that stops halfway leaves a mods folder
   * the game may refuse to start with.
   */
  handle('content:installMissingDependencies', (profileId: string) =>
    withProfileRollback(
      profileId,
      'Gerekli modlar',
      () => install.installMissingDependencies(profileId, onProgress),
      onProgress
    )
  )

  // ------------------------------------------------------------------ servers

  /** Every server call works on one profile's own `servers.dat`. */
  const serverDir = (profileId: string): string => {
    const profile = store.profile(profileId)
    if (!profile) throw new Error('Profil bulunamadı.')
    return profile.directory
  }

  handle('servers:list', (profileId: string) => servers.listServers(serverDir(profileId)))
  handle('servers:add', (profileId: string, input: { name: string; address: string }) =>
    servers.addServer(serverDir(profileId), input)
  )
  handle('servers:update', (profileId: string, index: number, input: { name: string; address: string }) =>
    servers.updateServer(serverDir(profileId), index, input)
  )
  handle('servers:remove', (profileId: string, index: number) =>
    servers.removeServer(serverDir(profileId), index)
  )
  handle('servers:move', (profileId: string, from: number, to: number) =>
    servers.moveServer(serverDir(profileId), from, to)
  )
  handle('servers:status', (address: string) => servers.serverStatus(address))

  /**
   * Adds the default servers to profiles that already exist.
   *
   * The separate, explicit action, as with the options template — except this
   * one only ever adds. A server list is a list, not a set of values to
   * overwrite, so there is nothing here that could take away what the player
   * put in.
   */
  handle('servers:applyToProfiles', async (profileIds: string[]) => {
    let added = 0
    for (const id of profileIds) {
      const profile = store.profile(id)
      if (profile) added += await servers.seedProfileServers(profile.directory, store.settings.minecraftServers ?? [])
    }
    return added
  })

  handle('skins:texture', (url: string) => skins.textureDataUrl(url))

  // ------------------------------------------------------------ skin library

  handle('skins:saved', () => skins.savedSkins())
  handle('skins:savedTexture', (id: string) => skins.savedSkinTexture(id))
  handle('skins:removeSaved', (id: string) => skins.removeSavedSkin(id))
  handle('skins:renameSaved', (id: string, name: string) => store.renameSavedSkin(id, name))

  /** Adds a picked file to the library without touching the account. */
  handle('skins:saveFile', async (filePath: string, name: string, variant: skins.SkinVariant) =>
    skins.saveSkinBuffer(await fsp.readFile(filePath), name, variant)
  )

  /**
   * Adds a Mojang-hosted skin to the library. The renderer passes the url it is
   * already displaying rather than the account id: re-asking Mojang would need a
   * live token to save a texture the launcher can already see, and would fail
   * for no reason once the session expired.
   */
  handle('skins:saveFromUrl', (url: string, name: string, variant: skins.SkinVariant) =>
    skins.saveSkinFromUrl(url, name, variant)
  )

  handle('skins:applySaved', (accountId: string, id: string) =>
    withAccount(accountId, async (account) =>
      applyWaitingOutLimit('Skin uygulanıyor', async () => {
        const info = await skins.applySavedSkin(account, id)
        store.upsertAccount({ ...account, skinUrl: info.skinUrl })
        return info
      })
    )
  )

  // ------------------------------------------------------------ game options

  handle('options:importFile', async () => {
    const window = getWindow()
    if (!window) throw new Error('Pencere bulunamadı.')
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Minecraft ayarları', extensions: ['txt'] }]
    })
    if (result.canceled) return null
    return fsp.readFile(result.filePaths[0], 'utf8')
  })

  // Applying to existing profiles is a separate, explicit action: it replaces a
  // file the player may have spent time tuning in-game.
  handle('options:applyToProfiles', async (profileIds: string[]) => {
    let applied = 0
    let deferred = 0
    for (const id of profileIds) {
      const profile = store.profile(id)
      if (!profile) continue
      if (sessions.has(id)) {
        pendingOptions.set(id, store.settings.minecraftOptions)
        deferred += 1
        continue
      }
      await recordManagedOptions(id, profile.directory, store.settings.minecraftOptions)
      await writeProfileOptions(profile.directory, store.settings.minecraftOptions, true)
      applied += 1
    }
    return { applied, deferred }
  })

  /**
   * Uses the badge the renderer drew as the app's icon.
   *
   * It arrives already drawn because only the renderer has a canvas. What the
   * operating system keeps for the *installed* app — the pinned shortcut, the
   * bundle in Finder, the .desktop entry — is baked at build time and cannot be
   * repainted from here; this changes the running window and its taskbar or
   * dock entry, which is what the player is looking at when they pick a colour.
   */
  handle('app:setMark', (dataUrl: string) => {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 400_000) {
      throw new Error('Simge görseli okunamadı.')
    }
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('Simge görseli okunamadı.')

    const window = BrowserWindow.getAllWindows()[0]
    window?.setIcon(image)
    // Windows and Linux read the window's own icon; macOS has no per-window
    // icon at all and takes it from the dock.
    if (process.platform === 'darwin') app.dock?.setIcon(image)
  })

  handle('app:version', () => app.getVersion())

  /**
   * Physical memory, in MB, for the memory sliders.
   *
   * The maximum used to be a flat 32 GB, so on an 8 GB machine three quarters
   * of the slider promised memory the JVM would refuse to reserve.
   *
   * It is now the machine's whole memory, rounded down onto the sliders' 512 MB
   * grid — "8 GB of RAM means the slider goes to 8", as asked. Half a gigabyte
   * used to be held back for the machine itself, which is sound advice and the
   * wrong place to enforce it: it put the top of the slider at 7.5 on an 8 GB
   * machine, so a profile already set to 8 could never be shown or set again
   * and slid down to 7.5 the moment the control was touched.
   */
  handle('app:totalMemoryMb', () =>
    Math.max(1024, Math.floor(os.totalmem() / 1024 / 1024 / 512) * 512)
  )
  handle('app:tokenStorage', () => store.encryption)

  // -------------------------------------------------------------- updates

  handle('updates:status', () => updater.currentStatus())
  handle('updates:check', () => updater.checkForUpdates(true))
  handle('updates:download', () => updater.downloadUpdate())
  handle('updates:install', () => updater.installUpdate())

  handle('app:openExternal', (url: string) => {
    // Only ever hand http(s) links to the OS.
    if (!/^https?:\/\//i.test(url)) throw new Error('Yalnızca http(s) bağlantıları açılabilir.')
    return shell.openExternal(url)
  })

  handle('window:minimize', () => getWindow()?.minimize())
  handle('window:maximize', () => {
    const window = getWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  handle('window:close', () => getWindow()?.close())
}
