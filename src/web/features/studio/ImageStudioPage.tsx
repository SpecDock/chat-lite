import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { api, StudioApiError } from '../../shared/api/client';
import ImageLightbox from '../messages/ImageLightbox';
import {
  STUDIO_ASPECTS,
  STUDIO_BUSY_MESSAGE,
  STUDIO_QUALITIES,
  STUDIO_REFERENCE_LIMIT,
  STUDIO_STYLES,
  aspectLabel,
  formatDuration,
  formatPixels,
  normalizeStudioImage,
  qualityLabel,
  styleLabel,
  sortStudioImages,
  studioFileUrl,
  studioResultText,
  studioStatusLabel,
  type StudioImage,
} from './studioImages';

gsap.registerPlugin(useGSAP);

type ReferenceImage = { id: string; file: File; url: string };
type Preview = { src: string; alt: string };

const POLL_MS = 1600;
const PIN_MS = 15000;

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

function clipboardImages(data: DataTransfer | null) {
  if (!data) return [];
  const fromItems = [...data.items]
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const files = fromItems.length ? fromItems : [...data.files];
  return files.filter(isImageFile);
}

function useStudioFeed() {
  const [serverItems, setServerItems] = useState<StudioImage[]>([]);
  const [pending, setPending] = useState<StudioImage[]>([]);
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const timerRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const pinnedRef = useRef<Map<string, number>>(new Map());
  const deletedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const pull = useCallback(async () => {
    clearTimer();
    const requestId = ++requestRef.current;
    try {
      const data = await api.listStudioImages();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      const images = data && typeof data === 'object' && 'images' in data ? data.images : undefined;
      if (!Array.isArray(images)) throw new Error('记录读取失败');
      const listed = sortStudioImages(images.flatMap(item => {
        const image = normalizeStudioImage(item);
        return image ? [image] : [];
      }));
      for (const id of deletedRef.current) {
        if (!listed.some(item => item.id === id)) deletedRef.current.delete(id);
      }
      const incoming = listed.filter(item => !deletedRef.current.has(item.id));
      const now = Date.now();
      for (const item of incoming) pinnedRef.current.delete(item.id);
      setServerItems(current => {
        const ids = new Set(incoming.map(item => item.id));
        const kept = current.filter(item => !ids.has(item.id) && (pinnedRef.current.get(item.id) ?? 0) > now);
        return sortStudioImages([...kept, ...incoming]);
      });
      setLoadError('');
      setReady(true);
      const pinnedActive = [...pinnedRef.current.values()].some(until => until > now);
      clearTimer();
      if (incoming.some(item => item.status === 'running') || pinnedActive) {
        timerRef.current = window.setTimeout(() => { void pull(); }, POLL_MS);
      }
    } catch (cause) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setLoadError(cause instanceof Error ? cause.message : '记录读取失败');
      setReady(true);
      clearTimer();
      timerRef.current = window.setTimeout(() => { void pull(); }, 3000);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void pull();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      clearTimer();
    };
  }, [pull]);

  const pin = useCallback((id: string) => {
    pinnedRef.current.set(id, Date.now() + PIN_MS);
  }, []);

  const markDeleted = useCallback((id: string) => {
    deletedRef.current.add(id);
    pinnedRef.current.delete(id);
  }, []);

  const ensurePolling = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => { void pull(); }, POLL_MS);
  }, [pull]);

  return { serverItems, setServerItems, pending, setPending, loadError, ready, pin, markDeleted, ensurePolling };
}

function StudioLoader() {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const dot = ref.current?.querySelector('.studio-loader__dot');
    if (!dot) return;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const edge = 48;
      gsap.timeline({ repeat: -1, defaults: { duration: 0.48, ease: 'power1.inOut' } })
        .to(dot, { x: edge })
        .to(dot, { y: edge })
        .to(dot, { x: 0 })
        .to(dot, { y: 0 });
    });
    return () => mm.revert();
  }, { scope: ref });

  return <div ref={ref} className="studio-loader" role="status">
    <span className="studio-loader__track" aria-hidden="true"><span className="studio-loader__dot" /></span>
    <span className="studio-loader__label">生成中</span>
  </div>;
}

function StudioFrame({ item, onZoom }: { item: StudioImage; onZoom?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const initialStatus = useRef(item.status);
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setAttempt(0);
    setBroken(false);
  }, [item.id, item.status]);

  useGSAP(() => {
    if (item.status !== 'succeeded' || broken) return;
    const shouldFade = initialStatus.current === 'running';
    initialStatus.current = 'succeeded';
    if (!shouldFade) return;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const image = ref.current?.querySelector('img');
      if (!image) return;
      gsap.from(image, { autoAlpha: 0, duration: 0.35, ease: 'power1.out' });
    });
    return () => mm.revert();
  }, { scope: ref, dependencies: [item.status, item.id, broken, attempt], revertOnUpdate: true });

  let body = null;
  if (item.status === 'running') body = <StudioLoader />;
  else if (item.status === 'failed' || broken) body = <p className="studio-frame__note">{broken ? '图片读取失败' : '生成失败'}</p>;
  else if (item.status === 'succeeded') {
    const image = <img
      src={attempt ? `${studioFileUrl(item.id)}?retry=${attempt}` : studioFileUrl(item.id)}
      alt={item.prompt || '生成的图片'}
      draggable={false}
      onError={() => {
        if (attempt < 1) setAttempt(1);
        else setBroken(true);
      }}
    />;
    body = onZoom
      ? <button type="button" className="studio-frame__open" onClick={onZoom} aria-label="查看大图">{image}</button>
      : image;
  }

  return <div ref={ref} className="studio-frame" aria-busy={item.status === 'running'}>{body}</div>;
}

function StudioCard({ item, deleting, onOpen, onDelete }: { item: StudioImage; deleting: boolean; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  return <div className="studio-card">
    <button
      type="button"
      className="studio-card__open"
      data-studio-id={item.id}
      aria-label={`${studioStatusLabel(item.status)}。${item.prompt || '未填写提示词'}`}
      onClick={() => onOpen(item.id)}
    >
      <StudioFrame item={item} />
      <span className="studio-card__copy">
        <span className={`studio-card__status is-${item.status}`}>{studioStatusLabel(item.status)}</span>
        <span className="studio-card__prompt">{item.prompt || '未填写提示词'}</span>
      </span>
    </button>
    <button type="button" className="studio-delete" disabled={deleting} onClick={() => onDelete(item.id)}>删除</button>
  </div>;
}

function StudioDetail({ item, zoomOpen, deleting, cooldownLeft, error, onClose, onZoom, onDelete, onRegenerate, onPreview }: { item: StudioImage; zoomOpen: boolean; deleting: boolean; cooldownLeft: number; error: string; onClose: () => void; onZoom: () => void; onDelete: () => void; onRegenerate: () => void; onPreview: (src: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const zoomOpenRef = useRef(zoomOpen);
  onCloseRef.current = onClose;
  zoomOpenRef.current = zoomOpen;

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('.studio-detail__panel', { autoAlpha: 0, y: 16, duration: 0.32, ease: 'power2.out' });
    });
    return () => mm.revert();
  }, { scope: rootRef });

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || zoomOpenRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      className="studio-detail"
      role="presentation"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="studio-detail__panel" role="dialog" aria-modal="true" aria-labelledby="studio-detail-title" onClick={event => event.stopPropagation()}>
        <div className="studio-detail__top">
          <h2 id="studio-detail-title">生成详情</h2>
          <div className="studio-detail__actions">
            <button type="button" className="studio-retry" disabled={deleting || cooldownLeft > 0 || !item.prompt.trim()} onClick={onRegenerate}>{cooldownLeft > 0 ? `${cooldownLeft}s` : '重新生成'}</button>
            <button type="button" className="studio-delete" disabled={deleting} onClick={onDelete}>删除</button>
            <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭详情" title="关闭"><X size={19} /></button>
          </div>
        </div>
        <div className="studio-detail__frame">
          <StudioFrame item={item} onZoom={item.status === 'succeeded' ? onZoom : undefined} />
        </div>
        <div className="studio-detail__meta">
        {error && <p className="error">{error}</p>}
        <dl className="studio-meta">
          <div><dt>比例</dt><dd>{aspectLabel(item.aspectRatio)}</dd></div>
          <div><dt>质量</dt><dd>{qualityLabel(item.quality)}</dd></div>
          <div><dt>风格</dt><dd>{styleLabel(item.style)}</dd></div>
          <div><dt>像素宽×高</dt><dd>{formatPixels(item.width, item.height)}</dd></div>
          <div><dt>提示词</dt><dd>{item.prompt || '—'}</dd></div>
          <div><dt>生成耗时</dt><dd>{formatDuration(item.durationMs)}</dd></div>
          <div><dt>响应或错误原因</dt><dd>{studioResultText(item)}</dd></div>
        </dl>
        {item.references.length > 0 && <div className="studio-detail__refs">
          {item.references.map((reference, index) => <button
            key={reference.id}
            type="button"
            className="studio-detail__ref"
            aria-label={`查看参考图 ${index + 1}`}
            onDoubleClick={() => onPreview(reference.url)}
          >
            <img src={reference.url} alt="" draggable={false} />
          </button>)}
        </div>}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function ImageStudioPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const referencesRef = useRef<ReferenceImage[]>([]);
  const { serverItems, setServerItems, pending, setPending, loadError, ready, pin, markDeleted, ensurePolling } = useStudioFeed();
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<(typeof STUDIO_ASPECTS)[number]>('auto');
  const [quality, setQuality] = useState<(typeof STUDIO_QUALITIES)[number]>('standard');
  const [style, setStyle] = useState<(typeof STUDIO_STYLES)[number]>('vivid');
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [formError, setFormError] = useState('');
  const [limitMessage, setLimitMessage] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownNow, setCooldownNow] = useState(0);
  const cooldownUntilRef = useRef(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  referencesRef.current = references;

  useLayoutEffect(() => {
    const node = promptRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const maxHeight = Number.parseFloat(window.getComputedStyle(node).maxHeight);
    const next = Math.min(node.scrollHeight, Number.isFinite(maxHeight) ? maxHeight : node.scrollHeight);
    node.style.height = `${next}px`;
    node.style.overflowY = node.scrollHeight > next + 1 ? 'auto' : 'hidden';
  }, [prompt]);

  useEffect(() => () => {
    for (const item of referencesRef.current) URL.revokeObjectURL(item.url);
  }, []);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('.studio-composer', {
        autoAlpha: 0,
        y: 12,
        duration: 0.32,
        ease: 'power2.out',
      });
    });
    return () => mm.revert();
  }, { scope: rootRef });

  const items = sortStudioImages([...pending, ...serverItems]);
  const detail = items.find(item => item.id === detailId) || null;

  const addFiles = (list: FileList | File[] | null) => {
    if (!list?.length) return;
    const incoming = [...list].filter(isImageFile);
    if (!incoming.length) {
      setFormError('请上传图片文件');
      return;
    }
    const room = STUDIO_REFERENCE_LIMIT - references.length;
    if (room <= 0) {
      setFormError('最多上传 16 张参考图');
      return;
    }
    const accepted = incoming.slice(0, room).map(file => ({ id: createId(), file, url: URL.createObjectURL(file) }));
    setFormError(incoming.length > room ? '最多上传 16 张参考图' : '');
    setReferences(current => [...current, ...accepted]);
  };

  const removeReference = (id: string) => {
    const target = references.find(item => item.id === id);
    if (target) URL.revokeObjectURL(target.url);
    setReferences(current => current.filter(item => item.id !== id));
  };

  const openDetail = (id: string) => setDetailId(id);

  const forgetImage = (id: string) => {
    markDeleted(id);
    setPending(current => current.filter(item => item.id !== id));
    setServerItems(current => current.filter(item => item.id !== id));
    setDetailId(current => current === id ? null : current);
    setPreview(current => current?.src === studioFileUrl(id) ? null : current);
  };

  const deleteImage = async (id: string) => {
    if (deletingId) return;
    setDeleteError(null);
    if (id.startsWith('local-')) {
      forgetImage(id);
      return;
    }
    setDeletingId(id);
    try {
      await api.deleteStudioImage(id);
      forgetImage(id);
    } catch (cause) {
      const missing = cause instanceof StudioApiError && cause.status === 404;
      if (missing) forgetImage(id);
      setDeleteError({ id, message: cause instanceof Error ? cause.message : '删除失败' });
    } finally {
      setDeletingId(current => current === id ? null : current);
    }
  };

  const closeDetail = () => {
    const id = detailId;
    setDetailId(null);
    if (!id) return;
    window.requestAnimationFrame(() => {
      galleryRef.current?.querySelector<HTMLButtonElement>(`[data-studio-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - cooldownNow) / 1000));

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setCooldownNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const submitGeneration = async (input: { promptText: string; aspectRatio: string; quality: string; style: string; images: File[]; openDetail: boolean }) => {
    if (Date.now() < cooldownUntilRef.current) return;
    const promptText = input.promptText.trim();
    if (!promptText) {
      setFormError('请输入提示词');
      return;
    }
    const now = Date.now();
    const until = now + 3000;
    cooldownUntilRef.current = until;
    setCooldownNow(now);
    setCooldownUntil(until);
    const clientKey = `local-${createId()}`;
    const optimistic: StudioImage = {
      id: clientKey,
      prompt: promptText,
      aspectRatio: input.aspectRatio,
      quality: input.quality,
      style: input.style,
      width: null,
      height: null,
      status: 'running',
      error: null,
      durationMs: null,
      createdAt: new Date().toISOString(),
      references: [],
    };
    setFormError('');
    setLimitMessage('');
    setPending(current => [optimistic, ...current]);
    if (input.openDetail) setDetailId(clientKey);
    try {
      const data = await api.createStudioImage({ prompt: promptText, aspectRatio: input.aspectRatio, quality: input.quality, style: input.style, images: input.images });
      const payload = data && typeof data === 'object' && 'image' in data ? data.image : undefined;
      const image = normalizeStudioImage(payload);
      if (!image) throw new Error('生成结果无法读取');
      pin(image.id);
      setPending(current => current.filter(item => item.id !== clientKey));
      setServerItems(current => sortStudioImages([image, ...current.filter(item => item.id !== image.id)]));
      setDetailId(current => current === clientKey ? image.id : current);
      ensurePolling();
    } catch (cause) {
      setPending(current => current.filter(item => item.id !== clientKey));
      setDetailId(current => current === clientKey ? null : current);
      if (cause instanceof StudioApiError && cause.status === 409) setLimitMessage(STUDIO_BUSY_MESSAGE);
      else setFormError(cause instanceof Error ? cause.message : '生成失败');
    }
  };

  const generate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitGeneration({
      promptText: prompt,
      aspectRatio,
      quality,
      style,
      images: references.map(item => item.file),
      openDetail: false,
    });
  };

  const regenerate = () => {
    if (!detail) return;
    void submitGeneration({
      promptText: detail.prompt,
      aspectRatio: detail.aspectRatio,
      quality: detail.quality,
      style: detail.style,
      images: [],
      openDetail: true,
    });
  };

  return <div ref={rootRef} className="studio">
    <div className="studio-history">
      <div className="studio-board">
        {loadError && <p className="error studio-load-error">{loadError}</p>}
        {deleteError && detailId !== deleteError.id && <p className="error studio-load-error">{deleteError.message}</p>}
        {!ready && <p className="studio-empty">正在读取</p>}
        <div ref={galleryRef} className="studio-gallery">
          {items.map(item => <StudioCard key={item.id} item={item} deleting={deletingId === item.id} onOpen={openDetail} onDelete={id => { void deleteImage(id); }} />)}
        </div>
      </div>
    </div>
    <form className="composer studio-composer" onSubmit={event => { void generate(event); }}>
      <div className="studio-bar">
        {references.length > 0 && <div className="studio-refs">
          {references.map(item => <div className="attach-thumb" key={item.id}>
            <img src={item.url} alt={item.file.name} draggable={false} onDoubleClick={() => setPreview({ src: item.url, alt: item.file.name })} />
            <button type="button" className="attach-thumb__remove" onClick={() => removeReference(item.id)} onDoubleClick={event => event.stopPropagation()} aria-label={`移除参考图 ${item.file.name}`} title="移除">
              <X size={12} />
            </button>
          </div>)}
        </div>}
        <div className="studio-prompt-row">
          <label className={references.length >= STUDIO_REFERENCE_LIMIT ? 'studio-upload is-disabled' : 'studio-upload'}>
            <ImagePlus size={16} aria-hidden="true" />
            <span>参考图 {references.length}/{STUDIO_REFERENCE_LIMIT}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              disabled={references.length >= STUDIO_REFERENCE_LIMIT}
              aria-label="上传参考图"
              onChange={event => {
                addFiles(event.target.files);
                event.currentTarget.value = '';
              }}
            />
          </label>
          <textarea
            ref={promptRef}
            id="studio-prompt"
            className="studio-prompt"
            name="prompt"
            rows={1}
            value={prompt}
            aria-label="提示词"
            autoComplete="off"
            onChange={event => setPrompt(event.target.value)}
            onPaste={event => {
              const images = clipboardImages(event.clipboardData);
              if (!images.length) return;
              event.preventDefault();
              addFiles(images);
            }}
          />
          <label className="studio-label studio-label-aspect" htmlFor="studio-aspect">
            比例
            <select id="studio-aspect" name="aspectRatio" value={aspectRatio} onChange={event => setAspectRatio(event.target.value as (typeof STUDIO_ASPECTS)[number])}>
              {STUDIO_ASPECTS.map(value => <option key={value} value={value}>{aspectLabel(value)}</option>)}
            </select>
          </label>
          <label className="studio-label studio-label-quality" htmlFor="studio-quality">
            质量
            <select id="studio-quality" name="quality" value={quality} onChange={event => setQuality(event.target.value as (typeof STUDIO_QUALITIES)[number])}>
              {STUDIO_QUALITIES.map(value => <option key={value} value={value}>{qualityLabel(value)}</option>)}
            </select>
          </label>
          <label className="studio-label studio-label-style" htmlFor="studio-style">
            风格
            <select id="studio-style" value={style} onChange={event => setStyle(event.target.value as (typeof STUDIO_STYLES)[number])}>
              {STUDIO_STYLES.map(value => <option key={value} value={value}>{styleLabel(value)}</option>)}
            </select>
          </label>
          <button className="studio-submit" type="submit" disabled={!prompt.trim() || cooldownLeft > 0} aria-describedby={limitMessage ? 'studio-limit' : undefined}>{cooldownLeft > 0 ? `${cooldownLeft}s` : '生成'}</button>
        </div>
        {limitMessage && <p id="studio-limit" className="error" role="alert">{limitMessage}</p>}
        {formError && <p className="error" role="alert">{formError}</p>}
      </div>
    </form>
    {detail && <StudioDetail
      key={detail.id}
      item={detail}
      zoomOpen={Boolean(preview)}
      deleting={deletingId === detail.id}
      cooldownLeft={cooldownLeft}
      error={deleteError?.id === detail.id ? deleteError.message : ''}
      onClose={closeDetail}
      onDelete={() => { void deleteImage(detail.id); }}
      onRegenerate={regenerate}
      onPreview={src => setPreview({ src, alt: '参考图' })}
      onZoom={() => setPreview({ src: studioFileUrl(detail.id), alt: detail.prompt || '生成的图片' })}
    />}
    {preview && <ImageLightbox src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />}
  </div>;
}
