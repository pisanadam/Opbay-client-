import { useEffect, useRef, useState } from 'react'
import type {
  ContentKind,
  CrashReport,
  InstalledContent,
  LoaderId,
  ProfileHealthReport,
  ProfileHistoryEntry,
  ProfileSafeModeState,
  ProfileStorageCategory,
  ProfileStorageReport
} from '../../shared/types'
import { Icon } from '../components/Icon'
import { OptionsEditor } from '../components/OptionsEditor'
import { ProfileIcon } from '../components/ProfileIcon'
import { ScreenshotGallery, type GalleryItem } from '../components/ScreenshotGallery'
import { ServersTab } from '../components/ServersTab'
import { memoryAdvice, type MeasuredSession } from '../../shared/memoryAdvice'
import { parseOptions, readOption } from '../../shared/options'
import { Confirm, Modal } from '../components/Modal'
import type { AutoWorldBackupSummary, JavaInfo, WorldSummary } from '../../preload'
import { api } from '../lib/api'
import { formatPlaytime, formatRelative, loaderLabel } from '../lib/format'
import { useApp } from '../state/AppContext'
import { IconEditor } from '../components/IconEditor'
import type { IconRecipe } from '../../shared/profileIcon'
import { t } from '../../shared/i18n'

type Tab = 'mods' | 'resourcepacks' | 'shaders' | 'worlds' | 'screenshots' | 'servers' | 'logs' | 'settings'

const TABS: { id: Tab; label: string; kind?: ContentKind }[] = [
  { id: 'mods', label: 'Modlar', kind: 'mod' },
  { id: 'resourcepacks', label: 'Doku paketleri', kind: 'resourcepack' },
  { id: 'shaders', label: 'Shaderlar', kind: 'shader' },
  { id: 'worlds', label: 'Dünyalar', kind: 'world' },
  { id: 'screenshots', label: 'Ekran görüntüleri' },
  { id: 'servers', label: 'Sunucular' },
  { id: 'logs', label: 'Günlük' },
  { id: 'settings', label: 'Ayarlar' }
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function ProfileDetail({
  profileId,
  initialTab,
  initialTabRequestKey,
  onBack,
  onBrowse
}: {
  profileId: string
  initialTab?: Tab
  initialTabRequestKey?: number
  onBack: () => void
  onBrowse: (profileId: string, kind?: ContentKind) => void
}): JSX.Element {
  const { profiles, refreshProfiles, gameStates, notify, tasks } = useApp()
  const profile = profiles.find((entry) => entry.id === profileId)

  // The recorded list can lag behind the folders — a modpack writes its jars
  // straight to disk, and players drop files in themselves. Reconciling on open
  // is what keeps the tabs honest.
  useEffect(() => {
    api.content
      .sync(profileId)
      .then(() => refreshProfiles())
      .catch(() => undefined)
  }, [profileId, refreshProfiles])
  const [tab, setTab] = useState<Tab>(initialTab ?? 'mods')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    setTab(initialTab ?? 'mods')
  }, [profileId, initialTab, initialTabRequestKey])

  if (!profile) {
    return (
      <div className="page">
        <div className="empty">
          <div className="empty__title">{t('Profil bulunamadı')}</div>
          <button className="btn" onClick={onBack}>
            {t('Kitaplığa dön')}
          </button>
        </div>
      </div>
    )
  }

  const state = gameStates[profile.id]
  const running = state === 'running' || state === 'preparing'
  /** The install this profile is waiting on, so the page can show its progress. */
  const installTask = tasks.find((task) => task.profileId === profile.id && task.state === 'running')

  const contentKind = TABS.find((entry) => entry.id === tab)?.kind

  return (
    <div className="page page--profile">
      <header className="page__header">
        <button className="btn btn--ghost btn--icon" onClick={onBack} aria-label="Geri">
          <Icon name="close" size={18} />
        </button>
        <div>
          <h1 className="page__title">
            <ProfileIcon profile={profile} size={30} />{' '}
            {profile.preparing && (
              <span className="badge badge--accent" style={{ marginRight: 8 }}>
                {t('Hazırlanıyor')}
              </span>
            )}
            {profile.name}
          </h1>
          <p className="page__subtitle">
            {profile.gameVersion} · {loaderLabel(profile.loader)}
            {profile.loaderVersion ? ` ${profile.loaderVersion}` : ''} ·{' '}
            {t('{playtime} oynandı · son oynama {when}', {
              playtime: formatPlaytime(profile.totalPlaytimeMs),
              when: formatRelative(profile.lastPlayed)
            })}
          </p>
        </div>
        <div className="topbar__spacer" />

        <button className="btn" onClick={() => void api.profiles.openFolder(profile.id)}>
          <Icon name="folder" size={16} />
          {t('Klasör')}
        </button>
        <button className="btn" onClick={() => onBrowse(profile.id)}>
          <Icon name="compass" size={16} />
          {t('İçerik ekle')}
        </button>
        {running ? (
          <button className="btn btn--danger" onClick={() => void api.game.kill(profile.id)}>
            <Icon name="stop" size={16} />
            {t('Durdur')}
          </button>
        ) : (
          <>
            {/* One button. Safe mode is a state the profile is left in, offered in its
                own settings; an offline launch is not a choice at all — the launcher
                sees there is no network and starts that way by itself. Both used to
                stand here and made starting the game read as a decision. */}
            <button
              className="btn btn--primary"
              // A profile whose mods are still downloading has no loader and
              // half a mods folder; starting it produces a crash, not a game.
              //
              // `launching` closes the gap before the game reports itself as
              // preparing: getting there reads every mod jar, which on a large
              // profile is long enough to click twice.
              disabled={profile.preparing || launching}
              title={profile.preparing ? t('Paket hâlâ indiriliyor') : undefined}
              onClick={async () => {
                setLaunching(true)
                try {
                  await api.game.launch(profile.id)
                } catch (error) {
                  notify(error, 'error')
                } finally {
                  setLaunching(false)
                }
              }}
            >
              <Icon name="play" size={16} />
              {t('Oyna')}
            </button>
          </>
        )}
      </header>

      {/* While a pack is still downloading, its own page is the place to watch
          it. The tabs below would show an empty mod list and a Play button that
          cannot be pressed, which reads as a broken profile rather than an
          unfinished one. */}
      {profile.preparing ? (
        <div className="settings-group">
          <div className="row" style={{ gap: 12 }}>
            <div className="spinner" />
            <div>
              <div className="settings-row__label">{t('Modlar kuruluyor')}</div>
              <div className="faint">
                {installTask?.detail ?? installTask?.label ?? t('Paket hazırlanıyor…')}
              </div>
            </div>
          </div>

          {installTask && installTask.progress >= 0 && (
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={Math.round(installTask.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress__bar" style={{ width: `${Math.round(installTask.progress * 100)}%` }} />
            </div>
          )}

          <div className="faint">
            {t('Bu profil kurulum bitene kadar başlatılamaz. Launcher’ı kapatmayın.')}
          </div>
        </div>
      ) : (
      <>
      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {t(entry.label)}
            {entry.kind && entry.kind !== 'world' && (
              <span className="nav-item__badge" style={{ marginLeft: 8 }}>
                {profile.content.filter((item) => item.kind === entry.kind).length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Content tabs are the ones that name a kind. Listing the exceptions by
          hand meant every new tab had to remember to opt out — and "Sunucular"
          did not, so it rendered the mods view instead of itself. */}
      {contentKind && contentKind !== 'world' && (
        <ContentTab
          profileId={profile.id}
          kind={contentKind}
          items={profile.content.filter((item) => item.kind === contentKind)}
          onChanged={refreshProfiles}
          onBrowse={() => onBrowse(profile.id, contentKind)}
        />
      )}

      {tab === 'worlds' && <WorldsTab profileId={profile.id} />}
      {tab === 'screenshots' && <ScreenshotsTab profileId={profile.id} />}
      {tab === 'servers' && <ServersTab profile={profile} />}
      {tab === 'logs' && <LogsTab profileId={profile.id} onOpenTab={(target) => setTab(target)} />}
      {tab === 'settings' && (
        <ProfileSettingsTab profileId={profile.id} onDeleteRequested={() => setConfirmDelete(true)} />
      )}
      </>
      )}

      {confirmDelete && (
        <Confirm
          title="Profili sil"
          danger
          confirmLabel={t('Profili ve dosyaları sil')}
          message={
            t(
              '{name} profili ve {directory} klasöründeki tüm modlar, dünyalar ve ayarlar kalıcı olarak silinecek. Bu işlem geri alınamaz.',
              { name: profile.name, directory: profile.directory }
            )
          }
          onConfirm={async () => {
            await api.profiles.remove(profile.id, true)
            await refreshProfiles()
            onBack()
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

function ContentTab({
  profileId,
  kind,
  items,
  onChanged,
  onBrowse
}: {
  profileId: string
  kind: ContentKind
  items: InstalledContent[]
  onChanged: () => Promise<void>
  onBrowse: () => void
}): JSX.Element {
  const { notify } = useApp()
  const [checking, setChecking] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [pendingUpdates, setPendingUpdates] = useState<InstalledContent[] | null>(null)
  // Removing content deletes the jar from disk, and the button that does it sits
  // next to the on/off switch — one slip and a mod the player spent a download
  // on is gone with nothing to undo it.
  const [pendingRemove, setPendingRemove] = useState<InstalledContent | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [contentFilter, setContentFilter] = useState<'all' | 'enabled' | 'disabled' | 'updates' | 'recent'>('all')
  const [contentQuery, setContentQuery] = useState('')

  const updatable = items.filter((item) => item.updateAvailable && !item.pinned)
  const selectedItems = items.filter((item) => selected.has(item.id))
  const visibleItems = items.filter((item) => {
    const query = contentQuery.trim().toLocaleLowerCase()
    if (query && !`${item.name} ${item.fileName}`.toLocaleLowerCase().includes(query)) return false
    if (contentFilter === 'enabled') return item.enabled
    if (contentFilter === 'disabled') return !item.enabled
    if (contentFilter === 'updates') return Boolean(item.updateAvailable)
    if (contentFilter === 'recent') return item.installedAt >= Date.now() - 7 * 24 * 60 * 60 * 1000
    return true
  })

  /**
   * Takes files dropped anywhere on the tab. What each one is gets decided in
   * the main process by looking inside the archive, so a world, a resource pack
   * and a handful of mods can be dropped together.
   */
  const acceptDrop = async (event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDropping(false)

    const paths = [...event.dataTransfer.files].map((file) => api.app.pathForFile(file)).filter(Boolean)
    if (paths.length === 0) return

    await run('import', async () => {
      await api.content.importPaths(profileId, paths)
      notify(paths.length === 1 ? 'Dosya kuruldu.' : `${paths.length} dosya kuruldu.`)
    })
  }

  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyId(id)
    try {
      await action()
      await onChanged()
    } catch (error) {
      notify(error, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className={dropping ? 'stack-lg dropzone dropzone--over' : 'stack-lg dropzone'}
      onDragOver={(event) => {
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(event) => {
        // Moving between children fires dragleave too; only leaving the tab counts.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(event) => void acceptDrop(event)}
    >
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn--primary" onClick={onBrowse}>
          <Icon name="compass" size={16} />
          {t('Mağazadan ekle')}
        </button>
        <button
          className="btn"
          onClick={() => void run('import', () => api.content.importLocal(profileId, kind))}
          disabled={busyId === 'import'}
        >
          <Icon name="folder" size={16} />
          Dosyadan ekle
        </button>
        <button
          className="btn"
          disabled={checking || items.length === 0}
          onClick={async () => {
            setChecking(true)
            try {
              await api.content.checkUpdates(profileId)
              await onChanged()
            } catch (error) {
              notify(error, 'error')
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? <div className="spinner" /> : <Icon name="refresh" size={16} />}
          {t('Güncellemeleri denetle')}
        </button>

        {visibleItems.length > 0 && (
          <label className="row faint" style={{ gap: 7 }}>
            <input
              type="checkbox"
              checked={visibleItems.every((item) => selected.has(item.id))}
              ref={(node) => {
                if (node) {
                  node.indeterminate =
                    visibleItems.some((item) => selected.has(item.id)) &&
                    !visibleItems.every((item) => selected.has(item.id))
                }
              }}
              onChange={(event) => setSelected(event.target.checked ? new Set(visibleItems.map((item) => item.id)) : new Set())}
            />
            {selected.size > 0 ? t('{count} seçili', { count: selected.size }) : t('Tümünü seç')}
          </label>
        )}

        {selectedItems.length > 0 && (
          <>
            <button
              className="btn btn--sm"
              disabled={busyId !== null}
              onClick={() => void run('bulk-enable', async () => {
                await api.content.toggleMany(profileId, selectedItems.map((item) => item.id), true)
                setSelected(new Set())
              })}
            >
              {t('Etkinleştir')}
            </button>
            <button
              className="btn btn--sm"
              disabled={busyId !== null}
              onClick={() => void run('bulk-disable', async () => {
                await api.content.toggleMany(profileId, selectedItems.map((item) => item.id), false)
                setSelected(new Set())
              })}
            >
              {t('Devre dışı bırak')}
            </button>
          </>
        )}

        <input
          className="input input--compact"
          value={contentQuery}
          placeholder={t('İçerikte ara')}
          aria-label={t('İçerikte ara')}
          onChange={(event) => {
            setContentQuery(event.target.value)
            setSelected(new Set())
          }}
        />
        <select
          className="select"
          value={contentFilter}
          aria-label={t('İçerik filtresi')}
          onChange={(event) => {
            setContentFilter(event.target.value as typeof contentFilter)
            setSelected(new Set())
          }}
        >
          <option value="all">{t('Tümü')}</option>
          <option value="enabled">{t('Etkin')}</option>
          <option value="disabled">{t('Devre dışı')}</option>
          <option value="updates">{t('Güncellemesi olanlar')}</option>
          <option value="recent">{t('Son 7 günde eklenenler')}</option>
        </select>

        <div className="topbar__spacer" />

        {updatable.length > 0 && (
          <button
            className="btn btn--primary"
            disabled={busyId !== null}
            onClick={() => setPendingUpdates(updatable)}
          >
            <Icon name="download" size={16} />
            {t('{count} güncellemeyi uygula', { count: updatable.length })}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty empty--droppable">
          <div className="empty__icon">{dropping ? '📥' : '📭'}</div>
          <div className="empty__title">
            {dropping ? t('Bırakın, kuralım') : t('Bu profilde içerik yok')}
          </div>
          <p>
            {t(
              'Mağazadan kurabilir, dosya seçebilir ya da jar, dünya, doku paketi ve shader dosyalarını doğrudan buraya sürükleyebilirsiniz.'
            )}
          </p>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="empty">
          <div className="empty__title">{t('Filtreye uyan içerik yok')}</div>
          <p>{t('Aramayı veya seçili filtreyi değiştirin.')}</p>
        </div>
      ) : (
        <div className="list">
          {visibleItems.map((item) => (
            <div key={item.id} className={item.enabled ? 'list__row' : 'list__row list__row--disabled'}>
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                aria-label={t('{name} seç', { name: item.name })}
                onChange={(event) => setSelected((current) => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(item.id)
                  else next.delete(item.id)
                  return next
                })}
              />
              {item.iconUrl ? (
                <img className="list__icon" src={item.iconUrl} alt="" loading="lazy" />
              ) : (
                <div className="list__icon" />
              )}

              <div className="list__main">
                <div className="list__title">
                  {item.name}
                  {item.updateAvailable && (
                    <span className="badge badge--warning" style={{ marginLeft: 8 }}>
                      {t('Yeni sürüm çıktı')}
                    </span>
                  )}
                  {item.source === 'local' && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      yerel
                    </span>
                  )}
                  {item.pinned && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {t('Sürüm sabit')}
                    </span>
                  )}
                  {!item.enabled && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {t('Devre dışı')}
                    </span>
                  )}
                </div>
                <div className="list__sub">{item.fileName}</div>
              </div>

              {item.updateAvailable && !item.pinned && (
                <button
                  className="btn btn--sm btn--primary"
                  disabled={busyId !== null}
                  onClick={() => setPendingUpdates([item])}
                >
                  <Icon name="download" size={14} />
                  {t('Güncelle')}
                </button>
              )}

              {item.source !== 'local' && (
                <button
                  className="btn btn--ghost btn--icon"
                  aria-label={item.pinned ? t('Sürüm sabitlemesini kaldır') : t('Bu sürümü sabitle')}
                  title={item.pinned ? t('Sürüm sabitlemesini kaldır') : t('Bu sürümü sabitle')}
                  disabled={busyId !== null}
                  onClick={() => void run(item.id, () => api.content.pin(profileId, item.id, !item.pinned))}
                >
                  <Icon name={item.pinned ? 'check' : 'package'} size={16} />
                </button>
              )}

              <button
                className="switch"
                role="switch"
                aria-checked={item.enabled}
                aria-label={item.enabled ? t('Devre dışı bırak') : t('Etkinleştir')}
                disabled={busyId === item.id}
                onClick={() => void run(item.id, () => api.content.toggle(profileId, item.id, !item.enabled))}
              />

              <button
                className="btn btn--ghost btn--icon"
                aria-label={t('Kaldır')}
                disabled={busyId === item.id}
                onClick={() => setPendingRemove(item)}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingRemove && (
        <Confirm
          title={t('Kaldırmayı onayla')}
          message={t('"{name}" bu profilden silinecek. Dosya diskten kaldırılır; geri almak için yeniden indirmeniz gerekir.', {
            name: pendingRemove.name
          })}
          confirmLabel={t('Kaldır')}
          danger
          onConfirm={() => {
            const target = pendingRemove
            void run(target.id, () => api.content.remove(profileId, target.id))
          }}
          onClose={() => setPendingRemove(null)}
        />
      )}

      {pendingUpdates && (
        <Modal
          title={t('Mod güncellemesini onayla')}
          onClose={() => setPendingUpdates(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPendingUpdates(null)}>
                {t('Vazgeç')}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  const requested = pendingUpdates
                  setPendingUpdates(null)
                  void (async () => {
                    for (const item of requested) {
                      await run(item.id, () => api.content.update(profileId, item.id))
                    }
                  })()
                }}
              >
                <Icon name="download" size={15} />
                {t('Yine de güncelle')}
              </button>
            </>
          }
        >
          <p className="muted" style={{ marginBottom: 0 }}>
            {pendingUpdates.length === 1
              ? t('{name} yalnızca onay verirseniz güncellenecek. Kurulu sürüm o zamana kadar değişmez.', {
                  name: pendingUpdates[0].name
                })
              : t('{count} içerik yalnızca onay verirseniz güncellenecek. Kurulu sürümler o zamana kadar değişmez.', {
                  count: pendingUpdates.length
                })}
          </p>
          <div className="notice notice--warning">
            <Icon name="refresh" size={19} />
            <div>
              <strong>{t('Güncelleme riskli olabilir')}</strong>
              {t('Bu güncelleme profili veya modları bozabilir ya da kararsız hâle getirebilir.')}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function WorldsTab({ profileId }: { profileId: string }): JSX.Element {
  const { notify, profiles, refreshProfiles } = useApp()
  const profile = profiles.find((entry) => entry.id === profileId)!
  const [worlds, setWorlds] = useState<WorldSummary[]>([])
  const [backups, setBackups] = useState<AutoWorldBackupSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingDelete, setPendingDelete] = useState<WorldSummary | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)
  const [pendingRestore, setPendingRestore] = useState<AutoWorldBackupSummary | null>(null)

  const reload = async (): Promise<void> => {
    setLoading(true)
    try {
      const [worldList, backupList] = await Promise.all([
        api.worlds.list(profileId),
        api.worlds.autoBackups(profileId)
      ])
      setWorlds(worldList)
      setBackups(backupList)
    } catch (error) {
      notify(error, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  return (
    <div className="stack-lg">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="chip"
          aria-pressed={profile.autoBackupWorlds === true}
          onClick={async () => {
            try {
              await api.profiles.update(profileId, { autoBackupWorlds: !profile.autoBackupWorlds })
              await refreshProfiles()
              notify(profile.autoBackupWorlds ? t('Otomatik dünya yedeği kapatıldı.') : t('Otomatik dünya yedeği açıldı.'))
            } catch (error) {
              notify(error, 'error')
            }
          }}
        >
          {t('Otomatik yedek')}: {profile.autoBackupWorlds ? t('Açık') : t('Kapalı')}
        </button>
        <button className="btn" onClick={() => void api.worlds.openAutoBackups(profileId).catch((error) => notify(error, 'error'))}>
          <Icon name="folder" size={16} />
          {t('Otomatik yedekler')}
        </button>
        <button
          className="btn btn--primary"
          onClick={async () => {
            try {
              const imported = await api.content.importLocal(profileId, 'world')
              if (imported.length > 0) await reload()
            } catch (error) {
              notify(error, 'error')
            }
          }}
        >
          <Icon name="download" size={16} />
          {t('Dünya içe aktar (.zip)')}
        </button>
        <button
          className="btn"
          onClick={async () => {
            try {
              const folder = await api.worlds.importBackup(profileId)
              if (!folder) return
              await reload()
              notify(t('Dünya yedeği içe aktarıldı.'))
            } catch (error) {
              notify(error, 'error')
            }
          }}
        >
          <Icon name="download" size={16} />
          {t('PisanKus yedeğini içe aktar')}
        </button>
        <button className="btn" onClick={() => void reload()}>
          <Icon name="refresh" size={16} />
          Yenile
        </button>
      </div>

      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 30 }}>
          <div className="spinner" />
        </div>
      ) : worlds.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">🌍</div>
          <div className="empty__title">{t('Kayıtlı dünya yok')}</div>
          <p>{t('Oyunda yeni bir dünya oluşturun ya da elinizdeki bir dünya arşivini içe aktarın.')}</p>
        </div>
      ) : (
        <div className="list">
          {worlds.map((world) => (
            <div key={world.folderName} className="list__row">
              <div className="list__icon" style={{ display: 'grid', placeItems: 'center' }}>
                🌍
              </div>
              <div className="list__main">
                <div className="list__title">{world.displayName}</div>
                <div className="list__sub">
                  {t('{size} MB · son değişiklik {when}', {
                    size: world.sizeMb,
                    when: formatRelative(world.lastPlayed)
                  })}
                </div>
              </div>
              <button
                className="btn btn--sm"
                disabled={!backups.some((backup) => backup.folderName === world.folderName)}
                onClick={() => setPendingRestore(backups.find((backup) => backup.folderName === world.folderName) ?? null)}
              >
                <Icon name="refresh" size={14} />
                {t('Son yedeğe dön')}
              </button>
              <button
                className="btn btn--sm"
                disabled={exporting === world.folderName}
                onClick={async () => {
                  setExporting(world.folderName)
                  try {
                    const saved = await api.worlds.exportBackup(
                      profileId,
                      world.folderName,
                      world.displayName
                    )
                    if (saved) notify(t('Dünya yedeği dışa aktarıldı.'))
                  } catch (error) {
                    notify(error, 'error')
                  } finally {
                    setExporting(null)
                  }
                }}
              >
                <Icon name="download" size={14} />
                Yedekle
              </button>
              <button
                className="btn btn--ghost btn--icon"
                aria-label={t('Dünyayı sil')}
                onClick={() => setPendingDelete(world)}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingDelete && (
        <Confirm
          title={t('Dünyayı sil')}
          danger
          confirmLabel={t('Kalıcı olarak sil')}
          message={
            t('{name} dünyası ve içindeki tüm ilerleme silinecek. Bu işlem geri alınamaz.', {
              name: pendingDelete.displayName
            })
          }
          onConfirm={async () => {
            setWorlds(await api.worlds.remove(profileId, pendingDelete.folderName))
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}

      {pendingRestore && (
        <Confirm
          title={t('Dünya yedeğini geri yükle')}
          confirmLabel={t('Geri yükle')}
          message={t('Dünyanın şu anki hâli önce ayrıca yedeklenecek, ardından {date} tarihli kopya geri yüklenecek.', {
            date: new Date(pendingRestore.createdAt).toLocaleString('tr-TR')
          })}
          onConfirm={async () => {
            try {
              setWorlds(await api.worlds.restoreAutoBackup(profileId, pendingRestore.folderName, pendingRestore.backupId))
              setBackups(await api.worlds.autoBackups(profileId))
              notify(t('Dünya yedeği geri yüklendi.'))
            } catch (error) {
              notify(error, 'error')
            }
          }}
          onClose={() => setPendingRestore(null)}
        />
      )}
    </div>
  )
}

function ScreenshotsTab({ profileId }: { profileId: string }): JSX.Element {
  const { notify } = useApp()
  const [items, setItems] = useState<GalleryItem[] | null>(null)

  const reload = async (): Promise<void> => {
    try {
      const list = await api.screenshots.list(profileId)
      setItems(list.map((item) => ({ ...item, profileId })))
    } catch (error) {
      setItems([])
      notify(error, 'error')
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  return (
    <ScreenshotGallery
      items={items}
      onReload={() => void reload()}
      onRemove={(item) => {
        void api.screenshots
          .remove(profileId, item.fileName)
          .then((list) => setItems(list.map((entry) => ({ ...entry, profileId }))))
          .catch((error) => notify(error, 'error'))
      }}
      controls={
        <button
          className="btn"
          onClick={() => void api.screenshots.openFolder(profileId).catch((error) => notify(error, 'error'))}
        >
          <Icon name="folder" size={16} />
          {t('Klasörü aç')}
        </button>
      }
      emptyTitle={t('Henüz ekran görüntüsü yok')}
      emptyHint={t("Minecraft'ta F2 tuşuyla çektiğiniz görüntüler burada görünür.")}
    />
  )
}

function LogsTab({
  profileId,
  onOpenTab
}: {
  profileId: string
  onOpenTab: (tab: 'mods' | 'shaders' | 'settings') => void
}): JSX.Element {
  const { logs, clearLogs, notify } = useApp()
  const lines = logs[profileId] ?? []
  const consoleRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [reports, setReports] = useState<CrashReport[]>([])

  useEffect(() => {
    let active = true
    void api.crashes
      .list(profileId)
      .then((items) => {
        if (active) setReports(items)
      })
      .catch(() => {
        if (active) setReports([])
      })
    const unsubscribe = api.crashes.onCreated((report) => {
      if (report.profileId !== profileId) return
      setReports((current) => [report, ...current.filter((item) => item.id !== report.id)])
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [profileId])

  useEffect(() => {
    if (follow && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight
    }
  }, [lines, follow])

  const latest = reports[0]

  return (
    <div className="stack-lg">
      {/* What the launcher knows, and nothing it guessed. The analyser that used
          to sit here named a cause from keywords in the log; it was wrong often
          enough to send people after mods that were fine, while the one failure
          that mattered — a loader whose own build steps had never run — came out
          as "unknown crash". The log is the report. */}
      {latest && (
        <div className="card">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="section-title">{t('Son çökme')}</div>
            {latest.exitCode != null && (
              <span className="badge badge--danger">{t('Çıkış kodu {code}', { code: latest.exitCode })}</span>
            )}
            {latest.signal && <span className="badge badge--danger">{latest.signal}</span>}
            <div className="topbar__spacer" />
            <span className="faint">{new Date(latest.createdAt).toLocaleString('tr-TR')}</span>
          </div>

          <p className="muted">
            {latest.detectedWhileLauncherClosed
              ? t("PisanKus kapalıyken Minecraft'ın çöktüğü tespit edildi. Günlük aşağıda.")
              : t('Ne olduğu aşağıdaki günlükte yazıyor. Yardım isterken günlüğü kopyalayıp paylaşın.')}
          </p>

          {(latest.changesSinceLastSuccess?.length ?? 0) > 0 && (
            <details open>
              <summary>{t('Son başarılı çalıştırmadan beri değişenler')}</summary>
              <ul className="crash-analysis__steps">
                {latest.changesSinceLastSuccess!.map((change, index) => (
                  <li key={`${change.kind}-${change.contentId ?? index}`}>
                    <strong>{change.label}:</strong> {change.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(latest.sources?.length ?? 0) > 0 && (
            <details>
              <summary>{t('Kullanılan kaynaklar ({count})', { count: latest.sources!.length })}</summary>
              <ul className="crash-analysis__steps">
                {latest.sources!.map((source) => (
                  <li key={`${source.kind}-${source.path}`}>{source.kind} · {source.path}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn--primary btn--sm"
              onClick={() => void api.crashes
                .share(profileId, latest.id)
                .then((text) => navigator.clipboard.writeText(text))
                .then(() => notify(t('Günlük panoya kopyalandı. Jetonlar ve dosya yolları temizlendi.')))
                .catch((error) => notify(error, 'error'))}
            >
              <Icon name="copy" size={14} />
              {t('Günlüğü kopyala')}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => void api.crashes.openFolder(profileId).catch((error) => notify(error, 'error'))}
            >
              <Icon name="folder" size={14} />
              {t('Rapor klasörü')}
            </button>
            {reports.length > 1 && (
              <span className="faint">{t('Toplam {count} crash raporu', { count: reports.length })}</span>
            )}
          </div>
        </div>
      )}

      <div className="row">
        <button className="chip" aria-pressed={follow} onClick={() => setFollow((value) => !value)}>
          {t('Otomatik kaydır')}
        </button>
        <button className="btn btn--sm" onClick={() => clearLogs(profileId)}>
          {t('Temizle')}
        </button>
        <button
          className="btn btn--sm"
          onClick={() => void navigator.clipboard.writeText(lines.map((line) => line.line).join('\n'))}
          disabled={lines.length === 0}
        >
          <Icon name="copy" size={15} />
          {t('Kopyala')}
        </button>
        <div className="topbar__spacer" />
        <span className="faint">{t('{count} satır', { count: lines.length })}</span>
      </div>

      <div className="console" ref={consoleRef}>
        {lines.length === 0 ? (
          <span className="muted">{t('Oyun çalıştığında günlük çıktısı burada görünür.')}</span>
        ) : (
          lines.map((line, index) => (
            <div key={index} className={`console__line--${line.stream}`}>
              {line.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ProfileSettingsTab({
  profileId,
  onDeleteRequested
}: {
  profileId: string
  onDeleteRequested: () => void
}): JSX.Element {
  const { profiles, refreshProfiles, notify, settings, saveSettings, gameStates } = useApp()
  const profile = profiles.find((entry) => entry.id === profileId)!

  const [name, setName] = useState(profile.name)
  const [memory, setMemory] = useState(profile.memoryMb)
  const [jvmArgs, setJvmArgs] = useState(profile.jvmArgs ?? '')
  const [loaderVersions, setLoaderVersions] = useState<{ version: string; stable: boolean }[]>([])
  const [loaderVersion, setLoaderVersion] = useState(profile.loaderVersion ?? '')
  const [javaPath, setJavaPath] = useState(profile.javaPath ?? '')
  const [javaOptions, setJavaOptions] = useState<JavaInfo[]>([])
  const [customResolution, setCustomResolution] = useState(profile.resolution != null)
  const [resolutionWidth, setResolutionWidth] = useState(String(profile.resolution?.width ?? 1280))
  const [resolutionHeight, setResolutionHeight] = useState(String(profile.resolution?.height ?? 720))
  const [saving, setSaving] = useState(false)
  const [exportingProfile, setExportingProfile] = useState(false)
  const [options, setOptions] = useState<{ text: string; onDisk: boolean } | null>(null)
  const [editingOptions, setEditingOptions] = useState(false)
  const [editingIcon, setEditingIcon] = useState(false)
  const [dependencyBusy, setDependencyBusy] = useState(false)
  const [health, setHealth] = useState<ProfileHealthReport | null>(null)
  const [healthBusy, setHealthBusy] = useState<string | null>(null)
  const [safeMode, setSafeMode] = useState<ProfileSafeModeState | null>(null)
  const [storage, setStorage] = useState<ProfileStorageReport | null>(null)
  const [history, setHistory] = useState<ProfileHistoryEntry[]>([])
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null)

  // Read straight from the profile's folder rather than from the global
  // template: what matters here is the file the game will actually load.
  const loadOptions = (): void => {
    api.profiles
      .readOptions(profileId)
      .then(setOptions)
      .catch(() => setOptions(null))
  }
  useEffect(loadOptions, [profileId])

  /**
   * Read again whenever the game stops holding the file.
   *
   * Minecraft writes the whole of options.txt when it quits, so anything read
   * when this page was first drawn is out of date the moment a session ends.
   * The editor was opening on that stale copy: it showed the values the
   * launcher last wrote while the file on disk said something else, and saving
   * pushed the stale document back over what the game had just written.
   */
  const gameStatus = gameStates[profileId]
  useEffect(() => {
    if (gameStatus === undefined || gameStatus === 'exited' || gameStatus === 'crashed') loadOptions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStatus, profileId])

  useEffect(() => {
    if (profile.loader === 'vanilla') return
    void (async () => {
      try {
        setLoaderVersions(await api.versions.loaders(profile.loader, profile.gameVersion))
      } catch {
        setLoaderVersions([])
      }
    })()
  }, [profile.loader, profile.gameVersion])

  useEffect(() => {
    void api.versions.java().then(setJavaOptions).catch(() => setJavaOptions([]))
  }, [profileId])

  const refreshMaintenance = async (): Promise<void> => {
    const [nextHealth, nextSafeMode, nextStorage, nextHistory] = await Promise.all([
      api.profiles.health(profileId),
      api.profiles.safeMode(profileId),
      api.profiles.storage(profileId),
      api.profiles.history(profileId)
    ])
    setHealth(nextHealth)
    setSafeMode(nextSafeMode)
    setStorage(nextStorage)
    setHistory(nextHistory)
  }

  useEffect(() => {
    void refreshMaintenance().catch(() => undefined)
  }, [profileId])

  const width = Number(resolutionWidth)
  const height = Number(resolutionHeight)
  const resolutionValid =
    !customResolution ||
    (Number.isFinite(width) && width >= 320 && width <= 16_384 &&
      Number.isFinite(height) && height >= 240 && height <= 8_640)
  const resolutionDirty = customResolution
    ? profile.resolution?.width !== Math.round(width) || profile.resolution?.height !== Math.round(height)
    : profile.resolution !== undefined

  const dirty =
    name !== profile.name ||
    memory !== profile.memoryMb ||
    jvmArgs !== (profile.jvmArgs ?? '') ||
    loaderVersion !== (profile.loaderVersion ?? '') ||
    javaPath !== (profile.javaPath ?? '') ||
    resolutionDirty

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.profiles.update(profileId, {
        name: name.trim() || profile.name,
        memoryMb: memory,
        jvmArgs: jvmArgs.trim() || undefined,
        loaderVersion: loaderVersion || undefined,
        javaPath: javaPath.trim() || undefined,
        resolution: customResolution
          ? { width: Math.round(width), height: Math.round(height) }
          : undefined
      })
      await refreshProfiles()
    } catch (error) {
      notify(error, 'error')
    } finally {
      setSaving(false)
    }
  }

  /**
   * How far the slider goes: what the machine actually has, less a little for
   * the machine itself. A flat maximum let a profile be set to memory the JVM
   * would then refuse to reserve — and that shows up as a failed launch, not as
   * a slider that stops.
   */
  const [totalMemory, setTotalMemory] = useState<number | null>(null)
  /** False in a dev run, where a shortcut would point at a bare Electron. */
  const [canShortcut, setCanShortcut] = useState(false)
  const [shortcutBusy, setShortcutBusy] = useState(false)

  /** Weight of the mods folder, and what the game was measured using. */
  const [modBytes, setModBytes] = useState(0)
  const [measured, setMeasured] = useState<MeasuredSession[]>([])

  /**
   * What this profile's memory ought to be.
   *
   * Both inputs are about this profile specifically: what its mods weigh, and —
   * once it has been played — how much the game actually held. A mod count
   * would say the same thing about ninety-six small tweaks and ninety-six heavy
   * content mods.
   */
  const advice = memoryAdvice({
    currentMb: memory,
    modBytes,
    totalMb: totalMemory ?? undefined,
    sessions: measured
  })

  useEffect(() => {
    void api.app.totalMemoryMb().then(setTotalMemory).catch(() => undefined)
    void api.profiles.canCreateShortcut().then(setCanShortcut).catch(() => undefined)
    void api.profiles
      .storage(profileId)
      .then((report) => setModBytes(report.entries.find((entry) => entry.category === 'mods')?.bytes ?? 0))
      .catch(() => undefined)
    void api.stats
      .sessions()
      .then((all) => {
        const mine = all.find((entry) => entry.profileId === profileId)?.sessions ?? []
        setMeasured(
          mine.flatMap((session) =>
            // Both numbers or neither: a peak without the limit it ran under
            // cannot be read at all.
            session.peakMb && session.capMb ? [{ peakMb: session.peakMb, capMb: session.capMb }] : []
          )
        )
      })
      .catch(() => undefined)
  }, [])

  const managedCount = Object.keys(profile.managedOptions ?? {}).length

  /**
   * Launcher-managed settings whose value is not what options.txt currently
   * says.
   *
   * This is the one question that could not be answered from the outside: a
   * setting that "does not apply" is either one the launcher never wrote or one
   * the game overrode, and those need opposite fixes. Comparing what the
   * launcher holds against the file it just read separates them on sight.
   */
  const managedMismatches = options
    ? Object.entries(profile.managedOptions ?? {}).filter(
        ([key, value]) => readOption(parseOptions(options.text), key) !== value
      )
    : []
  const optionCount = options ? parseOptions(options.text).filter((line) => !('raw' in line)).length : 0

  /**
   * Keeps the newest eight choices, newest first and without repeats — a row of
   * the same icon four times is not a shortcut to anything.
   */
  const rememberIcon = async (recipe: IconRecipe): Promise<void> => {
    const previous = settings?.recentIcons ?? []
    const rest = previous.filter(
      (entry) => entry.background !== recipe.background || entry.symbol !== recipe.symbol
    )
    await saveSettings({ recentIcons: [recipe, ...rest].slice(0, 8) })
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      {editingIcon && (
        <IconEditor
          name={profile.name}
          initial={profile.iconRecipe}
          recents={settings?.recentIcons ?? []}
          onCancel={() => setEditingIcon(false)}
          onSave={async (dataUrl, recipe) => {
            try {
              await api.profiles.setDrawnIcon(profileId, dataUrl, recipe)
              await rememberIcon(recipe)
              await refreshProfiles()
              setEditingIcon(false)
            } catch (error) {
              notify(error, 'error')
            }
          }}
        />
      )}

      {editingOptions && options && (
        <OptionsEditor
          value={options.text}
          notify={notify}
          onClose={() => setEditingOptions(false)}
          onSave={async (text) => {
            const { deferred } = await api.profiles.writeOptions(profileId, text)
            setOptions({ text, onDisk: true })
            setEditingOptions(false)
            notify(
              deferred
                ? t('Minecraft açık. Ayarlar oyun kapandığında yazılacak.')
                : t('Bu profilin oyun ayarları kaydedildi.')
            )
          }}
        />
      )}

      <div className="settings-group">
        <div className="settings-row">
          <div>
            <div className="settings-row__label">{t('Profil adı')}</div>
            <div className="faint">{t('Kitaplıkta görünen ad')}</div>
          </div>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__label">{t('Simge')}</div>
            <div className="faint">
              {profile.iconImage ? t('Kendi görseliniz kullanılıyor') : t('Simge oluşturabilir ya da PNG/JPG yükleyebilirsiniz')}
            </div>
          </div>
          <div className="row settings-row__controls" style={{ gap: 8 }}>
            <ProfileIcon profile={profile} size={34} />
            <button className="btn btn--sm btn--primary" onClick={() => setEditingIcon(true)}>
              <Icon name="sparkle" size={15} />
              {t('Simge oluştur')}
            </button>
            <button
              className="btn btn--sm"
              onClick={async () => {
                try {
                  if (await api.profiles.pickIcon(profileId)) await refreshProfiles()
                } catch (error) {
                  notify(error, 'error')
                }
              }}
            >
              <Icon name="image" size={15} />
              {t('Görsel seç')}
            </button>
            {profile.iconImage && (
              // Icon only: the four controls together are wider than the
              // settings column, and this is the one whose meaning survives
              // without a word next to it.
              <button
                className="btn btn--sm btn--icon"
                title={t('Kaldır')}
                aria-label={t('Kaldır')}
                onClick={async () => {
                  await api.profiles.clearIcon(profileId)
                  await refreshProfiles()
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>
        </div>

        {canShortcut && (
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{t('Masaüstü kısayolu')}</div>
              <div className="faint">
                {t('Çift tıklayınca launcher açılıp doğrudan bu profili başlatır')}
              </div>
            </div>
            <button
              className="btn"
              disabled={shortcutBusy}
              onClick={async () => {
                setShortcutBusy(true)
                try {
                  const file = await api.profiles.createShortcut(profileId)
                  notify(t('Kısayol oluşturuldu: {file}', { file }))
                } catch (error) {
                  notify(error, 'error')
                } finally {
                  setShortcutBusy(false)
                }
              }}
            >
              {shortcutBusy ? <div className="spinner" /> : <Icon name="external" size={16} />}
              {t('Masaüstüne ekle')}
            </button>
          </div>
        )}

        {/* Beside the other per-profile settings rather than in the mod list: it
            is a repair, done once when something is wrong, not part of adding
            content. */}
        <div className="settings-row">
          <div>
            <div className="settings-row__label">{t('Gerekli kütüphaneler')}</div>
            <div className="faint">
              {t('Kurulu modların gerektirdiği ama eksik olan kütüphaneleri indirir (Sodium için Fabric API gibi)')}
            </div>
          </div>
          <button
            className="btn btn--sm"
            disabled={dependencyBusy}
            onClick={async () => {
              setDependencyBusy(true)
              try {
                const report = await api.content.installMissingDependencies(profileId)
                await refreshProfiles()
                if (report.installed.length === 0 && report.unavailable.length === 0) {
                  notify(t('Eksik kütüphane yok.'))
                } else if (report.unavailable.length === 0) {
                  notify(t('{count} kütüphane kuruldu: {list}', {
                    count: report.installed.length,
                    list: report.installed.map((item) => item.name).join(', ')
                  }))
                } else {
                  notify(
                    t('{count} kütüphane kuruldu. Bu sürüme yayınlanmamış olanlar: {list}', {
                      count: report.installed.length,
                      list: report.unavailable.map((item) => `${item.name} (${item.requiredBy})`).join(', ')
                    }),
                    'error'
                  )
                }
              } catch (error) {
                notify(error, 'error')
              } finally {
                setDependencyBusy(false)
              }
            }}
          >
            {dependencyBusy ? <div className="spinner" /> : <Icon name="download" size={15} />}
            {t('Eksikleri indir')}
          </button>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__label">{t('Oyun ayarları')}</div>
            <div className="faint">
              {options === null
                ? 'Okunuyor…'
                : options.onDisk
                  ? t('Bu profilin options.txt dosyası · {count} ayar', { count: optionCount })
                  : t('Bu profilde henüz options.txt yok — kaydedince oluşturulur')}
            </div>
          </div>
          <button
            className="btn btn--sm"
            disabled={options === null}
            // Re-read on the way in as well: the file can change under the
            // launcher at any time, and an editor showing anything other than
            // the file the game will read is worse than no editor at all.
            onClick={() => {
              // Cleared first so the editor, which is only rendered once
              // `options` is there, waits for the fresh read instead of
              // mounting on the copy this page happened to be holding.
              setOptions(null)
              loadOptions()
              setEditingOptions(true)
            }}
          >
            <Icon name="settings" size={15} />
            {t('Düzenle')}
          </button>
        </div>

        {/* Shown only once the launcher is holding something. Otherwise it is a
            line explaining a mechanism nobody has met yet. */}
        {managedCount > 0 && (
          <div className="settings-row">
            <div>
              <div className="faint">
                {t(
                  'Burada değiştirdiğiniz {count} ayar her başlatmadan önce yeniden uygulanıyor; oyun dosyayı sıfırlasa bile geri geliyor.',
                  { count: managedCount }
                )}
              </div>
              {managedMismatches.length > 0 && (
                <div className="faint" style={{ marginTop: 4 }}>
                  {t('Şu an dosyada farklı: {list}', {
                    list: managedMismatches
                      .map(
                        ([key, value]) =>
                          `${key} (${t('istenen')} ${value}, ${t('dosyada')} ${
                            readOption(parseOptions(options?.text ?? ''), key) ?? t('yok')
                          })`
                      )
                      .join(', ')
                  })}
                </div>
              )}
            </div>
            <button
              className="btn btn--sm"
              onClick={async () => {
                try {
                  await api.profiles.clearManagedOptions(profileId)
                  await refreshProfiles()
                  notify(t('Oyun ayarları artık oyuna bırakıldı.'))
                } catch (error) {
                  notify(error, 'error')
                }
              }}
            >
              {t('Oyuna bırak')}
            </button>
          </div>
        )}

        <div className="settings-row">
          <div>
            <div className="settings-row__label">{t('Ayrılan bellek')}</div>
            {/* What this profile actually wants, rather than a fixed sentence:
                the number depends on how many mods are in it and on how much
                the machine has, and both are known here. */}
            <div className={advice.warning ? 'settings-row__warn' : 'faint'}>
              {(memory / 1024).toFixed(1)} GB — {t(advice.reason, advice.reasonParams)}
            </div>
          </div>
          <div className="row settings-row__controls" style={{ gap: 10 }}>
            {advice.recommendedMb !== memory && (
              <button
                className={advice.warning ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
                onClick={() => setMemory(advice.recommendedMb)}
              >
                {t('{size} GB yap', { size: (advice.recommendedMb / 1024).toFixed(1) })}
              </button>
            )}
            <input
              type="range"
              min={1024}
              // Never below what this profile is already set to: a maximum under
              // the stored value lets the input clamp it, and the next touch saves
              // the clamped number as though it had been chosen.
              max={Math.max(totalMemory ?? memory, memory)}
              step={512}
              value={memory}
              onChange={(event) => setMemory(Number(event.target.value))}
            />
          </div>
        </div>

        {profile.loader !== 'vanilla' && loaderVersions.length > 0 && (
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{t('{loader} sürümü', { loader: loaderLabel(profile.loader) })}</div>
              <div className="faint">{t('Değiştirildiğinde bir sonraki başlatmada kurulur')}</div>
            </div>
            <select
              className="select"
              value={loaderVersion}
              onChange={(event) => setLoaderVersion(event.target.value)}
            >
              <option value="">{t('En son kararlı')}</option>
              {loaderVersions.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {entry.version}
                  {entry.stable ? '' : ' ' + t('(kararsız)')}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label className="field__label" htmlFor="profile-java-path">
            {t("Bu profilin Java'sı")}
          </label>
          <input
            id="profile-java-path"
            className="input"
            list="profile-java-options"
            value={javaPath}
            placeholder={
              settings?.javaPath
                ? t('Genel: {path}', { path: settings.javaPath })
                : t('Boş bırakılırsa uygun Java otomatik seçilir')
            }
            onChange={(event) => setJavaPath(event.target.value)}
          />
          <datalist id="profile-java-options">
            {javaOptions.map((java) => (
              <option key={`${java.majorVersion}:${java.path}`} value={java.path}>
                Java {java.majorVersion} · {java.vendor}
              </option>
            ))}
          </datalist>
          <div className="field__hint">
            {javaPath
              ? t('Bu yol yalnızca bu profil için kullanılır.')
              : t('Genel Java ayarı veya launcher tarafından yönetilen Java kullanılır.')}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-row__label">{t('Özel çözünürlük')}</div>
            <div className="faint">{t('Kapalıysa Minecraft kendi pencere boyutunu kullanır')}</div>
          </div>
          <div className="row profile-resolution">
            {customResolution && (
              <>
                <input
                  className="input"
                  type="number"
                  min={320}
                  max={16_384}
                  aria-label={t('Çözünürlük genişliği')}
                  value={resolutionWidth}
                  onChange={(event) => setResolutionWidth(event.target.value)}
                />
                <span className="muted">×</span>
                <input
                  className="input"
                  type="number"
                  min={240}
                  max={8_640}
                  aria-label={t('Çözünürlük yüksekliği')}
                  value={resolutionHeight}
                  onChange={(event) => setResolutionHeight(event.target.value)}
                />
              </>
            )}
            <button
              className="switch"
              role="switch"
              aria-checked={customResolution}
              aria-label={t('Özel çözünürlüğü aç veya kapat')}
              onClick={() => setCustomResolution((enabled) => !enabled)}
            />
          </div>
        </div>
        {!resolutionValid && <div className="field__hint field__hint--danger">{t('Geçerli bir genişlik ve yükseklik girin.')}</div>}

        <div className="field">
          <label className="field__label" htmlFor="jvm-args">
            {t('JVM argümanları')}
          </label>
          <textarea
            id="jvm-args"
            className="textarea"
            value={jvmArgs}
            placeholder={t('Boş bırakılırsa genel ayarlardaki değerler kullanılır')}
            onChange={(event) => setJvmArgs(event.target.value)}
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn--primary" onClick={() => void save()} disabled={!dirty || saving || !resolutionValid}>
            {saving ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </div>

      <div className="settings-group">
        <div className="section-title">{t('Bakım')}</div>
        <div className="notice notice--warning" style={{ marginBottom: 14 }}>
          <Icon name="package" size={20} />
          <div style={{ flex: 1 }}>
            <strong>{safeMode?.active ? t('Güvenli mod açık') : t('Güvenli mod')}</strong>
            <span>
              {safeMode?.active
                ? t('{count} içerik geçici olarak kapalı. İstediğinizde önceki duruma dönebilirsiniz.', {
                    count: safeMode.disabledContentIds.length
                  })
                : t('Modları, shaderları ve doku paketlerini silmeden geçici olarak kapatır.')}
            </span>
          </div>
          <button
            className="btn btn--sm"
            disabled={maintenanceBusy !== null}
            onClick={async () => {
              setMaintenanceBusy('safe-mode')
              try {
                await api.profiles.safeMode(profileId, !safeMode?.active)
                await refreshProfiles()
                await refreshMaintenance()
                notify(safeMode?.active ? t('Güvenli mod geri alındı.') : t('Güvenli mod açıldı.'))
              } catch (error) {
                notify(error, 'error')
              } finally {
                setMaintenanceBusy(null)
              }
            }}
          >
            {safeMode?.active ? t('Önceki duruma dön') : t('Güvenli modu aç')}
          </button>
        </div>

        {storage && (
          <div className="stack" style={{ marginBottom: 18 }}>
            <div className="row">
              <div>
                <div className="settings-row__label">{t('Depolama kullanımı')}</div>
                <div className="faint">{t('Bu profil toplam {size} kullanıyor', { size: formatBytes(storage.totalBytes) })}</div>
              </div>
              <div className="topbar__spacer" />
              <button
                className="btn btn--sm"
                disabled={maintenanceBusy !== null}
                onClick={() => void api.profiles.storage(profileId).then(setStorage).catch((error) => notify(error, 'error'))}
              >
                <Icon name="refresh" size={14} />
                {t('Yenile')}
              </button>
            </div>
            <div className="maintenance-grid">
              {storage.entries.map((entry) => (
                <div className="maintenance-card" key={entry.category}>
                  <div>
                    <strong>{t(entry.category)}</strong>
                    <div className="faint">{formatBytes(entry.bytes)} · {t('{count} dosya', { count: entry.fileCount })}</div>
                  </div>
                  {entry.cleanable && entry.bytes > 0 && (
                    <button
                      className="btn btn--sm"
                      disabled={maintenanceBusy !== null}
                      onClick={async () => {
                        setMaintenanceBusy(`clean-${entry.category}`)
                        try {
                          setStorage(await api.profiles.cleanStorage(profileId, [entry.category as ProfileStorageCategory]))
                          setHistory(await api.profiles.history(profileId))
                          notify(t('Dosyalar çöp kutusuna taşındı.'))
                        } catch (error) {
                          notify(error, 'error')
                        } finally {
                          setMaintenanceBusy(null)
                        }
                      }}
                    >
                      {t('Temizle')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="stack" style={{ marginBottom: 14 }}>
          <div className="row">
            <div>
              <div className="settings-row__label">{t('Sorun denetimi')}</div>
              <div className="faint">{t('Eksik dosya, Java ve riskli profil ayarlarını denetler')}</div>
            </div>
            <div className="topbar__spacer" />
            <button
              className="btn btn--sm"
              disabled={healthBusy !== null}
              onClick={async () => {
                setHealthBusy('scan')
                try {
                  setHealth(await api.profiles.health(profileId))
                } catch (error) {
                  notify(error, 'error')
                } finally {
                  setHealthBusy(null)
                }
              }}
            >
              {healthBusy === 'scan' ? <div className="spinner" /> : <Icon name="refresh" size={15} />}
              {t('Şimdi tara')}
            </button>
          </div>

          {health && health.issues.length === 0 && (
            <div className="notice notice--success">
              <strong>{t('Sorun yok')}</strong>
              <span>{t('Bilinen bir dosya veya ayar sorunu bulunamadı.')}</span>
            </div>
          )}

          {health?.issues.map((issue) => (
            <div key={issue.id} className={issue.severity === 'error' ? 'notice notice--danger' : 'notice notice--warning'}>
              <div style={{ flex: 1 }}>
                <strong>{t(issue.title)}</strong>
                <span>{t(issue.detail)}</span>
              </div>
              {issue.fix && issue.fixLabel && (
                <button
                  className="btn btn--sm"
                  disabled={healthBusy !== null}
                  onClick={async () => {
                    setHealthBusy(issue.id)
                    try {
                      const report = await api.profiles.fixHealth(profileId, issue.fix!)
                      setHealth(report)
                      await refreshProfiles()
                      if (issue.fix === 'clear-custom-java') setJavaPath('')
                      if (issue.fix === 'set-safe-memory') setMemory(4096)
                      notify(t('Profil sorunu düzeltildi.'))
                    } catch (error) {
                      notify(error, 'error')
                    } finally {
                      setHealthBusy(null)
                    }
                  }}
                >
                  {healthBusy === issue.id ? <div className="spinner" /> : t(issue.fixLabel)}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="stack" style={{ marginBottom: 18 }}>
          <div className="settings-row__label">{t('Değişiklik geçmişi')}</div>
          {history.length === 0 ? (
            <div className="faint">{t('Henüz kaydedilmiş bir değişiklik yok.')}</div>
          ) : (
            <div className="history-list">
              {history.slice(0, 12).map((entry) => (
                <div className="history-row" key={entry.id}>
                  <div>
                    <strong>{t(entry.title)}</strong>
                    {entry.detail && <div className="faint">{t(entry.detail)}</div>}
                  </div>
                  <span className="faint">{formatRelative(entry.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.game.prepare(profileId)
              } catch (error) {
                notify(error, 'error')
              }
            }}
          >
            <Icon name="download" size={16} />
            {t('Dosyaları önceden indir')}
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.profiles.duplicate(profileId)
                await refreshProfiles()
                notify(t('Profil kopyalandı.'))
              } catch (error) {
                notify(error, 'error')
              }
            }}
          >
            <Icon name="copy" size={16} />
            Profili kopyala
          </button>
          <button
            className="btn"
            disabled={exportingProfile}
            onClick={async () => {
              setExportingProfile(true)
              try {
                const saved = await api.profiles.exportBackup(profileId)
                if (saved) notify(t('Profil yedeği dışa aktarıldı.'))
              } catch (error) {
                notify(error, 'error')
              } finally {
                setExportingProfile(false)
              }
            }}
          >
            <Icon name="download" size={16} />
            {t('Profil yedeği')}
          </button>
          <div className="topbar__spacer" />
          <button className="btn btn--danger" onClick={onDeleteRequested}>
            <Icon name="trash" size={16} />
            Profili sil
          </button>
        </div>
      </div>
    </div>
  )
}

export type { LoaderId }
