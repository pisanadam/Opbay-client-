/** Types shared between the Electron main process and the React renderer. */

import type { IconRecipe } from './profileIcon'

export type LoaderId = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'optifine'

export type ContentKind = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'world' | 'modpack'

/**
 * Which Microsoft identity platform a client id is registered with. A client id
 * only works against one of them, so this cannot be inferred at runtime.
 */
export type AuthMode = 'legacy' | 'azure'

/**
 * Whether a profile's mod loader is a meaningful filter for this kind.
 *
 * Only mods and modpacks are published against Fabric, Forge and friends. A
 * resource pack lists `minecraft` as its loader, a shader lists `iris` or
 * `canvas`, and a data pack lists `datapack` — so narrowing their versions by
 * the profile's loader matches nothing at all, and a perfectly good pack looks
 * unavailable. That is exactly what happened: a resource pack shown as
 * compatible still failed with "no compatible version found".
 */
export function loaderApplies(kind: ContentKind): boolean {
  return kind === 'mod' || kind === 'modpack'
}

/**
 * Whether a loader is one that mods are published for.
 *
 * OptiFine is a loader here because it is chosen the same way and installs the
 * same way, but it does not load mods — it patches the game itself. Filtering a
 * mod search by it would return an empty list on every search, so it is treated
 * like vanilla wherever mods are looked up.
 */
export function loadsMods(loader: LoaderId): boolean {
  return loader !== 'vanilla' && loader !== 'optifine'
}

/** Where each kind of content is installed, relative to a profile directory. */
export const CONTENT_DIRS: Record<ContentKind, string> = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  datapack: 'datapacks',
  world: 'saves',
  modpack: '.'
}

export interface Account {
  /** Minecraft profile UUID (dashless). */
  id: string
  name: string
  /**
   * Xbox user id, from the XSTS response.
   *
   * The game is launched with it, and it is not the Minecraft UUID: passing the
   * UUID here made the client report an Xbox identity that does not exist.
   * Missing on accounts stored before this was read; the next token refresh
   * fills it in.
   */
  xuid?: string
  /** Minecraft access token — never leaves the main process except for launch. */
  accessToken: string
  /** Unix ms at which `accessToken` stops being valid. */
  expiresAt: number
  /** Microsoft refresh token used to silently renew the session. */
  refreshToken: string
  /** Platform this account signed in through; renewals must use the same one. */
  authMode: AuthMode
  skinUrl?: string
  capeId?: string
  addedAt: number
}

export interface InstalledContent {
  /** Stable id: `${source}:${projectId}` for remote content, file hash for local. */
  id: string
  source: 'modrinth' | 'local'
  projectId?: string
  versionId?: string
  kind: ContentKind
  name: string
  fileName: string
  iconUrl?: string
  /** Set when the source reports a newer version for the profile's game/loader. */
  updateAvailable?: string
  /** A user choice to keep this exact version until they unpin it. */
  pinned?: boolean
  /**
   * For a modpack: the profile-relative paths this version of the pack wrote.
   *
   * Kept so an update can delete what the new version no longer ships. Without
   * it, updating a pack leaves the old build of every mod it replaced sitting in
   * `mods/` beside the new one, and two builds of the same mod is a profile that
   * does not start. Only the pack's own downloads are listed — files from
   * `overrides/` are configs the player may have edited since, and are left
   * alone.
   */
  packFiles?: string[]
  enabled: boolean
  installedAt: number
}

export interface Profile {
  id: string
  name: string
  /** Minecraft version, e.g. "1.21.4". */
  gameVersion: string
  loader: LoaderId
  /** Loader version; omitted means "latest for this game version". */
  loaderVersion?: string
  /** Emoji shown when no picture is set. */
  icon?: string
  /**
   * A picture the player chose, stored as a small data url.
   *
   * Kept inline rather than as a file path because the renderer cannot read the
   * disk: a path would need an IPC round trip every time a list was drawn. The
   * image is downscaled before it lands here, so the database stays small.
   */
  iconImage?: string
  /**
   * What the icon editor was set to when `iconImage` was made.
   *
   * The picture alone cannot be edited back into its parts, so the recipe is
   * kept beside it and the editor reopens where the player left it.
   */
  iconRecipe?: IconRecipe
  /** Absolute path to the isolated game directory. */
  directory: string
  memoryMb: number
  javaPath?: string
  jvmArgs?: string
  resolution?: { width: number; height: number }
  /** Copies each world before launch and keeps a short local history. */
  autoBackupWorlds?: boolean
  /**
   * Game options the player set through the launcher, re-applied before every
   * launch.
   *
   * Writing options.txt once is not enough to make a setting stick. Minecraft
   * rewrites the whole file when it quits, so anything the launcher wrote is
   * gone by the next start unless the game happened to read it first — and if
   * the file is ever rejected, the game replaces it with its own defaults and
   * the player's choice is lost with no trace. Keeping the handful of keys the
   * player actually changed here, and stamping them back on just before the
   * game reads the file, is what makes "I set this in the launcher" true.
   *
   * Only keys the player changed in the launcher are in here; everything else
   * in options.txt belongs to the game and is never touched.
   */
  managedOptions?: Record<string, string>
  content: InstalledContent[]
  /**
   * Set while a pack is still downloading into this profile.
   *
   * The profile row appears the moment the install starts rather than when it
   * finishes, so the player can see what is happening — but it cannot be
   * launched yet, and this is what says so.
   */
  preparing?: boolean
  /**
   * Kept at the top of the sidebar, whatever it was last played.
   *
   * The sidebar shows a shortlist ordered by when each profile was last played,
   * which is right most of the time and wrong for the one profile someone
   * always wants within reach — the server they play with friends, the world
   * they are building in. This is the answer to "stop moving it".
   */
  pinned?: boolean
  createdAt: number
  lastPlayed?: number
  totalPlaytimeMs: number
}

export type ProfileHealthFix =
  | 'create-profile-directory'
  | 'clear-custom-java'
  | 'set-safe-memory'
  | 'remove-missing-content'

export interface ProfileHealthIssue {
  id: string
  severity: 'warning' | 'error'
  title: string
  detail: string
  fix?: ProfileHealthFix
  fixLabel?: string
}

export interface ProfileHealthReport {
  checkedAt: number
  issues: ProfileHealthIssue[]
}

export type ProfileStorageCategory =
  | 'mods'
  | 'resourcepacks'
  | 'shaders'
  | 'worlds'
  | 'screenshots'
  | 'logs'
  | 'crashes'
  | 'cache'

export interface ProfileStorageEntry {
  category: ProfileStorageCategory
  bytes: number
  fileCount: number
  /** Only disposable categories expose cleanup. */
  cleanable: boolean
}

export interface ProfileStorageReport {
  checkedAt: number
  totalBytes: number
  entries: ProfileStorageEntry[]
}

/** One finished play session, as the profile's own history records it. */
export interface PlaySession {
  /** When the session started. */
  at: number
  /** How long it lasted, in milliseconds. */
  ms: number
  /**
   * The most memory the game held during it, in MB.
   *
   * Absent on sessions recorded before this was measured, and on platforms that
   * will not report it — which is why the memory advice treats it as evidence
   * when it exists rather than as a value it can count on.
   */
  peakMb?: number
  /**
   * The heap limit the session ran under, in MB.
   *
   * Recorded with the peak because the peak means nothing without it: a game
   * that reached 1.9 GB under a 2 GB limit may have wanted far more and simply
   * had nowhere to go, while one that reached 1.9 GB with 14 GB available had
   * every chance to take more and did not. Only the second is evidence.
   */
  capMb?: number
}

export type ProfileHistoryKind =
  | 'content-installed'
  | 'content-removed'
  | 'content-enabled'
  | 'content-disabled'
  | 'content-updated'
  | 'profile-settings'
  | 'safe-mode-enabled'
  | 'safe-mode-restored'
  | 'storage-cleaned'

export interface ProfileHistoryEntry {
  id: string
  at: number
  kind: ProfileHistoryKind
  title: string
  detail?: string
  contentId?: string
}

export interface ProfileSafeModeState {
  active: boolean
  enabledAt?: number
  disabledContentIds: string[]
}

export interface Settings {
  /** Root directory holding profiles, versions, assets and libraries. */
  dataDir: string
  defaultMemoryMb: number
  javaPath?: string
  jvmArgs: string
  /** Identity platform used for new sign-ins. */
  authMode: AuthMode
  /** Client id presented to that platform. */
  msClientId: string
  concurrentDownloads: number
  /** Results fetched per search page in Keşfet. Modrinth caps this at 100. */
  searchPageSize: number
  /**
   * The last few icon-editor choices, newest first.
   *
   * The recipe is kept rather than the picture: it is two short strings instead
   * of a data url, and it redraws at whatever size and name it is asked for.
   */
  recentIcons: IconRecipe[]
  keepLauncherOpen: boolean
  theme: 'dark' | 'light' | 'system'
  /** UI language code, or `system` to follow the operating system. */
  language: string
  accentColor: string
  /** Whether the launcher plays its welcome chime. */
  soundEffects: boolean
  /**
   * Raw options.txt written into every new profile. Empty means "don't manage
   * game options"; the file is kept verbatim so keys the launcher does not model
   * survive untouched.
   */
  minecraftOptions: string
  /**
   * Servers written into every new profile's list.
   *
   * The same idea as `minecraftOptions`, for the other file a fresh profile
   * starts without: a player who runs several profiles types the same addresses
   * into each of them. Only missing entries are ever added, matched by address,
   * so one removed on purpose does not reappear.
   */
  minecraftServers: { name: string; address: string }[]
  /** Cleared only on a fresh install, so the welcome screen shows exactly once. */
  welcomeSeen: boolean
}

/** A skin the player keeps in the launcher for quick switching. */
export interface SavedSkin {
  id: string
  name: string
  variant: 'classic' | 'slim'
  /** File name inside the launcher's `skins` folder. */
  fileName: string
  addedAt: number
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  /** `canSelfUpdate` is false where the build must be reinstalled by hand. */
  | { state: 'available'; version: string; canSelfUpdate: boolean }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface TaskProgress {
  id: string
  label: string
  /** 0..1, or -1 when the total is not yet known. */
  progress: number
  detail?: string
  state: 'running' | 'done' | 'error'
  error?: string
  /** Offers a way out of the failure instead of only naming it. */
  action?: 'signIn' | 'openCrash'
  actionProfileId?: string
  /**
   * The profile this work is for, when it is for one.
   *
   * Lets a profile's own page show what is happening to it. Without it the task
   * tray was the only place the progress existed, and a profile created for a
   * pack sat there saying "preparing" with nothing to say how far along it was.
   */
  profileId?: string
}

export interface GameLogLine {
  profileId: string
  stream: 'stdout' | 'stderr' | 'launcher'
  line: string
  at: number
}

export interface GameState {
  profileId: string
  status: 'preparing' | 'running' | 'exited' | 'crashed'
  pid?: number
  exitCode?: number
  /** OS signal reported when no numeric exit code exists. */
  signal?: string
}

/** Which kind of file a crash log line came out of. */
export type CrashSourceKind = 'minecraft-crash' | 'jvm-crash' | 'latest-log' | 'launcher-log'

export interface CrashSource {
  kind: CrashSourceKind
  /** Sanitized profile-relative name, never an absolute disk path. */
  path: string
  modifiedAt?: number
}

export type CrashChangeKind = 'added' | 'updated' | 'enabled' | 'loader' | 'java' | 'memory'

export interface CrashProfileChange {
  kind: CrashChangeKind
  label: string
  detail: string
  contentId?: string
}

/** A persisted, token-redacted explanation of a failed launch or game crash. */
/**
 * A crash that happened, and where to read about it.
 *
 * Deliberately no cause, no confidence and no suspected mod. Those were
 * guessed from keywords in the log and were wrong often enough to send people
 * after mods that were fine — while the one failure that mattered, a loader
 * whose own build steps had never run, came out as "unknown crash". What is
 * left is what the launcher actually knows: it crashed, when, how it exited,
 * what changed since the last run that worked, and the log itself.
 */
export interface CrashReport {
  id: string
  profileId: string
  profileName: string
  createdAt: number
  exitCode?: number
  signal?: string
  /** The sanitized log, which is the report. */
  logFile: string
  reportFile: string
  /** Which files the log was gathered from. */
  sources?: CrashSource[]
  /** Mods, memory or Java changed since the last successful run. */
  changesSinceLastSuccess?: CrashProfileChange[]
  detectedWhileLauncherClosed?: boolean
  sourceFingerprint?: string
}

export interface SearchResult {
  source: 'modrinth'
  projectId: string
  slug: string
  title: string
  description: string
  author?: string
  iconUrl?: string
  downloads: number
  follows?: number
  categories: string[]
  kind: ContentKind
  updatedAt?: string
}

export interface SearchQuery {
  query: string
  kind: ContentKind
  gameVersion?: string
  loader?: LoaderId
  sort?: 'relevance' | 'downloads' | 'follows' | 'updated' | 'newest'
  offset?: number
  limit?: number
}

export interface ProjectVersion {
  id: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  /** `release` | `beta` | `alpha`. */
  channel: string
  downloads: number
  publishedAt: string
  fileName: string
  fileUrl: string
  fileSize: number
  sha1?: string
  /** Required dependency project ids, resolved before install. */
  dependencies: { projectId?: string; versionId?: string; required: boolean }[]
}

export interface VersionSummary {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releaseTime: string
}
