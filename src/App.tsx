/**
 * @req REQ-101 — Phase 1 生产笔记列表、创建、选择、删除。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from './domain/note';
import { SCHEMA_VERSION, db, ensureSchema, type ManualRelation } from './storage/db';
import { autoSync, notifyLocalChange } from './sync/autoSync';
import { loadSyncConfig, saveSyncConfig } from './sync/sync';
import { parseSyncLink } from './sync/shareConfig';
import { createStoredNote, deleteNotes, listNotes } from './storage/notes';
import { getMetaValue, setMetaValue } from './storage/meta';
import {
  addManualRelation,
  listManualRelations,
  removeManualRelation
} from './storage/relations';
import { collectTags } from './domain/tags';
import {
  buildLinkIndex,
  getBacklinks,
  getOutgoingLinks,
  resolveTarget
} from './domain/wikiLinks';
import { LinkPanel } from './components/LinkPanel';
import { GraphView } from './components/GraphView';
import { CanvasView } from './components/CanvasView';
import { SyncPanel } from './components/SyncPanel';
import { MobileOnboarding } from './components/MobileOnboarding';
import { buildBm25Index, searchBm25 } from './search/bm25';
import { loadAiSettings, type AiSettings } from './ai/settings';
import { createEmbeddingProvider } from './ai/provider';
import { ensureVectorIndex } from './search/vectorIndex';
import { hybridSearch, type HybridHit } from './search/vector';
const NoteEditor = lazy(() =>
  import('./components/NoteEditor').then((module) => ({ default: module.NoteEditor }))
);
const DataPanel = lazy(() =>
  import('./components/DataPanel').then((module) => ({ default: module.DataPanel }))
);
const AiPanel = lazy(() =>
  import('./components/AiPanel').then((module) => ({ default: module.AiPanel }))
);
const AiDraftPanel = lazy(() =>
  import('./components/AiDraftPanel').then((module) => ({ default: module.AiDraftPanel }))
);
const QualityPanel = lazy(() =>
  import('./components/QualityPanel').then((module) => ({ default: module.QualityPanel }))
);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightQuery, setHighlightQuery] = useState('');
  const [dataOpen, setDataOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('正在初始化…');
  const [view, setView] = useState<'notes' | 'graph' | 'canvas'>('notes');
  const [manualRelations, setManualRelations] = useState<ManualRelation[]>([]);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [syncOpen, setSyncOpen] = useState(false);
  const [autoState, setAutoState] = useState(() => autoSync.getState());
  const [scannedConfig, setScannedConfig] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [hybridHits, setHybridHits] = useState<HybridHit[] | null>(null);
  const [hybridForQuery, setHybridForQuery] = useState<string | null>(null);
  const [searchReason, setSearchReason] = useState('');
  const [searchCoverage, setSearchCoverage] = useState<{ indexed: number; total: number } | null>(null);
  const [searchMode, setSearchMode] = useState<'fulltext' | 'hybrid'>('fulltext');
  const lastAutoSyncRef = useRef<string | null>(null);

  const selected = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId]
  );
  const linkIndex = useMemo(() => buildLinkIndex(notes), [notes]);
  const outgoing = useMemo(
    () => (selected ? getOutgoingLinks(selected, linkIndex) : []),
    [selected, linkIndex]
  );
  const backlinks = useMemo(
    () => (selected ? getBacklinks(selected, notes, linkIndex) : []),
    [selected, notes, linkIndex]
  );
  const searchIndex = useMemo(() => buildBm25Index(notes), [notes]);
  const searchHits = useMemo(
    () => searchBm25(searchIndex, searchQuery),
    [searchIndex, searchQuery]
  );
  const searching = searchQuery.trim().length > 0;
  const noteIdSet = useMemo(() => new Set(notes.map((note) => note.id)), [notes]);
  // 只有「当前查询」的混合结果才采用；新查询等待期间显示 BM25，避免误报混合检索。
  const activeHybrid = hybridHits && hybridForQuery === searchQuery ? hybridHits : null;
  const searchResults = (activeHybrid ?? searchHits).filter((hit) => noteIdSet.has(hit.noteId));

  // REQ-301：AI 启用且向量开启时，先增量建索引，再做 RRF；任一步失败都回退 BM25。
  // 每次查询开始先清空上一轮的混合结果，避免在新结果到达前显示旧命中。
  useEffect(() => {
    setHybridHits(null);
    setHybridForQuery(null);
    setSearchReason('');
    setSearchCoverage(null);
    setSearchMode('fulltext');
    if (!searching) return;
    const settings = aiSettings;
    if (!settings || !settings.enabled || !settings.vectorSearchEnabled) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const provider = createEmbeddingProvider(settings);
          await ensureVectorIndex(notes, settings, {
            provider,
            maxNotes: 50,
            signal: controller.signal
          });
          const result = await hybridSearch(
            searchQuery,
            searchIndex,
            settings,
            provider,
            db,
            controller.signal
          );
          if (cancelled) return;
          setHybridHits(result.hits);
          setHybridForQuery(searchQuery);
          setSearchMode(result.vectorUsed ? 'hybrid' : 'fulltext');
          setSearchReason(result.reason ?? '');
          setSearchCoverage(result.coverage ?? null);
        } catch (error) {
          if (cancelled) return;
          setHybridHits(null);
          setHybridForQuery(null);
          setSearchMode('fulltext');
          setSearchReason(
            controller.signal.aborted
              ? '向量检索超时，已回退全文'
              : `向量检索不可用：${String(error)}`
          );
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
      window.clearTimeout(timer);
    };
  }, [searching, searchQuery, searchIndex, notes, aiSettings]);
  const allTags = useMemo(() => collectTags(notes), [notes]);
  const allFolders = useMemo(
    () =>
      [...new Set(notes.map((note) => note.folder.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'zh-CN')
      ),
    [notes]
  );
  const visibleNotes = useMemo(
    () =>
      notes.filter((note) => {
        if (folderFilter !== null && note.folder !== folderFilter) return false;
        if (tagFilter && !note.tags.includes(tagFilter)) return false;
        return true;
      }),
    [notes, folderFilter, tagFilter]
  );
  useEffect(() => {
    if (tagFilter && !allTags.some(({ tag }) => tag === tagFilter)) setTagFilter(null);
  }, [allTags, tagFilter]);
  useEffect(() => {
    if (folderFilter && !allFolders.includes(folderFilter)) setFolderFilter(null);
  }, [allFolders, folderFilter]);

  const refresh = useCallback(async (preferredId?: string) => {
    const [list, relations] = await Promise.all([listNotes(), listManualRelations()]);
    setNotes(list);
    setManualRelations(relations);
    setSelectedId((current) => {
      const wanted = preferredId ?? current;
      if (wanted && list.some((note) => note.id === wanted)) return wanted;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void loadAiSettings()
      .then(setAiSettings)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureSchema()
      .then(async () => {
        const [list, relations] = await Promise.all([listNotes(), listManualRelations()]);
        if (cancelled) return;
        setStatus(`生产数据层 v${SCHEMA_VERSION} 就绪`);
        setNotes(list);
        setManualRelations(relations);
        setSelectedId(list[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(`初始化失败：${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      autoSync.subscribe((state) => {
        setAutoState(state);
        // 自动同步在 React 之外改库；同步成功时必须重载列表，否则界面还停在旧数据。
        if (state.status === 'idle' || state.status === 'conflict') {
          if (state.lastSuccessAt && state.lastSuccessAt !== lastAutoSyncRef.current) {
            lastAutoSyncRef.current = state.lastSuccessAt;
            void refresh();
          }
        }
      }),
    [refresh]
  );

  // 扫码配置：手机打开 <appUrl>#sync=... 时把服务器地址与 token 写入本地配置。
  useEffect(() => {
    const shared = parseSyncLink(window.location.hash);
    if (!shared) return;
    void (async () => {
      const current = await loadSyncConfig();
      // 载荷里的地址若是回环（PC 自己填的 127.0.0.1），手机改用当前页面 origin。
      const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(shared.u);
      const serverUrl = isLoopback ? window.location.origin : shared.u;
      await saveSyncConfig({ ...current, serverUrl, token: shared.t });
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setScannedConfig(true);
      setSyncOpen(true);
    })();
  }, []);

  // 手机首次进入：窄屏 + 没配置同步 + 之前没关过引导，才弹引导页。
  // 扫码链接（#sync=...）会自己写配置并打开面板，这里不重复打扰。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!window.matchMedia('(max-width: 720px)').matches) return;
      if (parseSyncLink(window.location.hash)) return;
      try {
        if (await getMetaValue('mobile_onboarding_seen')) return;
        const config = await loadSyncConfig();
        const configured =
          config.serverUrl.trim().length > 0 && config.token.trim().length >= 16;
        if (!configured && !cancelled) setOnboarding(true);
      } catch {
        /* 读取失败就不打扰 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissOnboarding = () => {
    setOnboarding(false);
    void setMetaValue('mobile_onboarding_seen', '1');
  };

  const openSyncFromOnboarding = () => {
    setOnboarding(false);
    void setMetaValue('mobile_onboarding_seen', '1');
    setSyncOpen(true);
  };

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const note = await createStoredNote({ title: '未命名笔记' });
      setTagFilter(null);
      setFolderFilter(null);
      setSearchQuery('');
      setHighlightQuery('');
      await refresh(note.id);
      notifyLocalChange();
    } finally {
      setCreating(false);
    }
  };

  const handleSaved = async (saved: Note) => {
    await refresh(saved.id);
    notifyLocalChange();
  };

  const handleDeleted = async () => {
    await refresh();
    notifyLocalChange();
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`将删除 ${ids.length} 篇笔记及其附件，此操作不可撤销。确定继续？`)) return;
    await deleteNotes(ids);
    setSelectedIds(new Set());
    setBatchMode(false);
    await refresh();
    notifyLocalChange();
  };

  const openWikiLink = (target: string) => {
    const resolved = resolveTarget(linkIndex, target);
    if (resolved.noteId) setSelectedId(resolved.noteId);
  };

  const handleAddManualRelation = async (sourceId: string, targetId: string) => {
    await addManualRelation(sourceId, targetId);
    setManualRelations(await listManualRelations());
    notifyLocalChange();
  };

  const handleRemoveManualRelation = async (id: string) => {
    await removeManualRelation(id);
    setManualRelations(await listManualRelations());
    notifyLocalChange();
  };

  const openSearchHit = (noteId: string) => {
    setSelectedId(noteId);
    setHighlightQuery(searchQuery);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          PKE <span>Phase 1</span>
        </div>
        <div className="db-status" data-testid="db-status">
          {status}
        </div>
        <button
          type="button"
          data-testid="graph-toggle"
          className={view === 'graph' ? 'active' : ''}
          onClick={() => setView((current) => (current === 'graph' ? 'notes' : 'graph'))}
        >
          {view === 'graph' ? '笔记' : '图谱'}
        </button>
        <button
          type="button"
          data-testid="canvas-toggle"
          className={view === 'canvas' ? 'active' : ''}
          onClick={() => setView((current) => (current === 'canvas' ? 'notes' : 'canvas'))}
        >
          {view === 'canvas' ? '笔记' : '画布'}
        </button>
        <button type="button" data-testid="open-data" onClick={() => setDataOpen(true)}>
          数据
        </button>
        <button
          type="button"
          className="primary"
          data-testid="new-note"
          onClick={() => void handleCreate()}
          disabled={creating}
        >
          {creating ? '创建中…' : '新建笔记'}
        </button>
      </header>

      <div className={`workspace${selected ? ' workspace--editing' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-title">
            笔记 <span data-testid="note-count">{visibleNotes.length}</span>
          </div>

          <div className="sidebar-tools">
            <button
              type="button"
              data-testid="sidebar-graph"
              onClick={() => setView((current) => (current === 'graph' ? 'notes' : 'graph'))}
            >
              {view === 'graph' ? '笔记' : '图谱'}
            </button>
            <button
              type="button"
              data-testid="sidebar-canvas"
              onClick={() => setView((current) => (current === 'canvas' ? 'notes' : 'canvas'))}
            >
              {view === 'canvas' ? '笔记' : '画布'}
            </button>
            <button type="button" data-testid="sidebar-sync" onClick={() => setSyncOpen(true)}>
              同步
              {autoState.conflicts.length > 0
                ? ` (${autoState.conflicts.length})`
                : autoState.status === 'error'
                  ? ' !'
                  : autoState.status === 'syncing'
                    ? ' …'
                    : ''}
            </button>
            <button type="button" data-testid="sidebar-data" onClick={() => setDataOpen(true)}>
              数据
            </button>
            <button type="button" data-testid="sidebar-ai" onClick={() => setAiOpen(true)}>
              AI
            </button>
            <button type="button" data-testid="sidebar-draft" onClick={() => setDraftOpen(true)}>
              草稿
            </button>
            <button type="button" data-testid="sidebar-quality" onClick={() => setQualityOpen(true)}>
              质量
            </button>
            <button
              type="button"
              data-testid="sidebar-new"
              onClick={() => void handleCreate()}
              disabled={creating}
            >
              新建
            </button>
            <button
              type="button"
              className={batchMode ? 'active' : ''}
              data-testid="batch-toggle"
              onClick={() => {
                setBatchMode((value) => !value);
                setSelectedIds(new Set());
              }}
            >
              {batchMode ? '取消批量' : '批量'}
            </button>
            {batchMode && (
              <button
                type="button"
                className="danger"
                data-testid="batch-delete"
                disabled={selectedIds.size === 0}
                onClick={() => void handleBatchDelete()}
              >
                删除选中（{selectedIds.size}）
              </button>
            )}
          </div>

          <div className="search-box">
            <input
              data-testid="search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索标题、正文、标签"
              aria-label="搜索笔记"
            />
            {searchQuery && (
              <button
                type="button"
                data-testid="clear-search"
                onClick={() => {
                  setSearchQuery('');
                  setHighlightQuery('');
                }}
              >
                清空
              </button>
            )}
          </div>

          {searching && (
            <div className="search-results" data-testid="search-results">
              <div className="search-count" data-testid="search-count">
                找到 {searchResults.length} 条
              </div>
              {activeHybrid !== null && (
                <div className="search-mode" data-testid="search-mode">
                  {searchMode === 'hybrid'
                    ? `混合检索（全文 + 语义${
                        searchCoverage ? `，索引 ${searchCoverage.indexed}/${searchCoverage.total}` : ''
                      }）`
                    : `全文检索（向量不可用${searchReason ? `：${searchReason}` : ''}）`}
                </div>
              )}
              {searchResults.length === 0 ? (
                <p className="sidebar-empty">没有匹配结果</p>
              ) : (
                <ul className="search-list">
                  {searchResults.map((hit) => {
                    const note = notes.find((item) => item.id === hit.noteId);
                    return (
                      <li key={hit.noteId}>
                        <button
                          type="button"
                          data-testid="search-result"
                          onClick={() => openSearchHit(hit.noteId)}
                        >
                          <span className="search-result-title">{note?.title || '未命名笔记'}</span>
                          <span className="search-result-snippet">{hit.snippet}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <div className="folder-filter" data-testid="folder-filter">
            <button
              type="button"
              className={folderFilter === null ? 'active' : ''}
              onClick={() => setFolderFilter(null)}
            >
              全部目录
            </button>
            <button
              type="button"
              className={folderFilter === '' ? 'active' : ''}
              onClick={() => setFolderFilter('')}
            >
              未分类
            </button>
            {allFolders.map((folder) => (
              <button
                type="button"
                key={folder}
                data-testid={`folder-${folder}`}
                className={folderFilter === folder ? 'active' : ''}
                onClick={() => setFolderFilter(folderFilter === folder ? null : folder)}
              >
                {folder}
              </button>
            ))}
          </div>

          {allTags.length > 0 && (
            <div className="tag-filter" data-testid="tag-filter">
              {allTags.map(({ tag, count }) => (
                <button
                  type="button"
                  key={tag}
                  className={tagFilter === tag ? 'active' : ''}
                  onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                >
                  #{tag} <span>{count}</span>
                </button>
              ))}
            </div>
          )}

          {notes.length === 0 ? (
            <p className="sidebar-empty" data-testid="empty-list">
              还没有笔记
            </p>
          ) : visibleNotes.length === 0 ? (
            <p className="sidebar-empty" data-testid="filtered-empty">
              没有匹配的笔记
            </p>
          ) : (
            <ul className="note-list" data-testid="note-list">
              {visibleNotes.map((note) => (
                <li key={note.id} className="note-row">
                  {batchMode && (
                    <input
                      type="checkbox"
                      data-testid="select-note"
                      aria-label={`选择 ${note.title || '未命名笔记'}`}
                      checked={selectedIds.has(note.id)}
                      onChange={() => toggleSelected(note.id)}
                    />
                  )}
                  <button
                    type="button"
                    className={`note-item${note.id === selectedId ? ' active' : ''}`}
                    data-note-id={note.id}
                    onClick={() => {
                      setSelectedId(note.id);
                      setHighlightQuery('');
                    }}
                  >
                    <span className="note-item-title">{note.title || '未命名笔记'}</span>
                    <span className="note-item-time">
                      {note.folder || '未分类'} · {formatDate(note.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="main">
          {view === 'graph' ? (
            <GraphView
              notes={notes}
              linkIndex={linkIndex}
              manualRelations={manualRelations}
              onAddManualRelation={handleAddManualRelation}
              onRemoveManualRelation={handleRemoveManualRelation}
              onOpenNote={(noteId) => {
                setSelectedId(noteId);
                setHighlightQuery('');
                setView('notes');
              }}
            />
          ) : view === 'canvas' ? (
            <CanvasView
              notes={notes}
              manualRelations={manualRelations}
              onAddManualRelation={handleAddManualRelation}
              onRemoveManualRelation={handleRemoveManualRelation}
              onOpenNote={(noteId) => {
                setSelectedId(noteId);
                setHighlightQuery('');
                setView('notes');
              }}
            />
          ) : selected ? (
            <Suspense fallback={<div className="empty"><p>正在加载编辑器…</p></div>}>
              <NoteEditor
                key={`${selected.id}-${editorEpoch}`}
                note={selected}
                onBack={() => setSelectedId(null)}
                onSaved={handleSaved}
                onDeleted={handleDeleted}
                onOpenLink={openWikiLink}
                highlightQuery={highlightQuery}
              />
            </Suspense>
          ) : (
            <div className="empty">
              <h1>Personal Knowledge Engine</h1>
              <p>还没有笔记。点右上角「新建笔记」开始。</p>
            </div>
          )}
        </main>

        {view === 'notes' && selected && (
          <aside className="links-sidebar">
            <LinkPanel
              outgoing={outgoing}
              backlinks={backlinks}
              onOpen={(noteId) => setSelectedId(noteId)}
            />
          </aside>
        )}
      </div>

      <div className="floating-actions" data-testid="floating-actions">
        <button
          type="button"
          data-testid="floating-graph"
          onClick={() => setView((current) => (current === 'graph' ? 'notes' : 'graph'))}
        >
          {view === 'graph' ? '笔记' : '图谱'}
        </button>
        <button
          type="button"
          data-testid="floating-canvas"
          onClick={() => setView((current) => (current === 'canvas' ? 'notes' : 'canvas'))}
        >
          {view === 'canvas' ? '笔记' : '画布'}
        </button>
        <button type="button" data-testid="floating-data" onClick={() => setDataOpen(true)}>
          数据
        </button>
        <button type="button" className="primary" data-testid="floating-new" onClick={() => void handleCreate()} disabled={creating}>
          新建
        </button>
      </div>

      {onboarding && (
        <MobileOnboarding onOpenSync={openSyncFromOnboarding} onDismiss={dismissOnboarding} />
      )}

      {syncOpen && (
        <SyncPanel
          importedFromLink={scannedConfig}
          onClose={() => setSyncOpen(false)}
          onSynced={async () => {
            await refresh();
            setEditorEpoch((value) => value + 1);
          }}
        />
      )}

      {aiOpen && (
        <Suspense fallback={null}>
          <AiPanel
            notes={notes}
            onClose={() => {
              setAiOpen(false);
              void loadAiSettings()
                .then(setAiSettings)
                .catch(() => undefined);
            }}
          />
        </Suspense>
      )}

      {qualityOpen && (
        <Suspense fallback={null}>
          <QualityPanel
            notes={notes}
            onClose={() => setQualityOpen(false)}
            onOpenNote={(id) => {
              setSelectedId(id);
              setQualityOpen(false);
            }}
            onChanged={async () => {
              await refresh();
            }}
          />
        </Suspense>
      )}

      {draftOpen && (
        <Suspense fallback={null}>
          <AiDraftPanel
            notes={notes}
            settings={aiSettings}
            onClose={() => setDraftOpen(false)}
            onCreated={async (note) => {
              await refresh(note.id);
            }}
          />
        </Suspense>
      )}

      {dataOpen && (
        <Suspense fallback={null}>
          <DataPanel
            notes={notes}
            manualRelations={manualRelations}
            onClose={() => setDataOpen(false)}
            onImported={async () => {
              await refresh();
              setEditorEpoch((value) => value + 1);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
