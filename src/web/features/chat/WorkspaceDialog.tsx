import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, File, FolderOpen, Image as ImageIcon, RefreshCw, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { WorkspaceFileDTO, WorkspaceFilesDTO } from '../../../shared/types';

gsap.registerPlugin(useGSAP);

type Props = {
  open: boolean;
  workspace?: WorkspaceFilesDTO;
  conversationId?: string;
  loading: boolean;
  error?: string;
  onClose: () => void;
  onRefresh: () => void;
  onPreview: (file: WorkspaceFileDTO) => void;
};

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function FileRow({ file, onPreview }: { file: WorkspaceFileDTO; onPreview: (file: WorkspaceFileDTO) => void }) {
  const isImage = file.mimeType.startsWith('image/');
  const content = <>
    <span className="workspace-file__icon" aria-hidden="true">{isImage ? <ImageIcon size={17} /> : <File size={17} />}</span>
    <span className="workspace-file__body"><strong title={file.name}>{file.name}</strong><small>{file.mimeType} · {formatSize(file.size)}</small></span>
    <span className="workspace-file__action" aria-hidden="true">{isImage ? '预览' : <Download size={16} />}</span>
  </>;
  return isImage
    ? <button type="button" className="workspace-file" onClick={() => onPreview(file)}>{content}</button>
    : <a className="workspace-file" href={file.downloadUrl} download>{content}</a>;
}

function FileSection({ bucket, files, onPreview }: { bucket: 'input' | 'output'; files: WorkspaceFileDTO[]; onPreview: (file: WorkspaceFileDTO) => void }) {
  return <section className="workspace-section">
    <header className="workspace-section__header"><span className="workspace-section__label"><FolderOpen size={17} />{bucket}</span><span>{files.length}</span></header>
    {files.length ? <div className="workspace-files">{files.map(file => <FileRow key={`${bucket}:${file.attachmentId || file.name}`} file={file} onPreview={onPreview} />)}</div> : <p className="workspace-empty">暂无文件</p>}
  </section>;
}

export default function WorkspaceDialog({ open, workspace, conversationId, loading, error, onClose, onRefresh, onPreview }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const activeElement = document.activeElement;
    restoreFocusRef.current = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      const element = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (element?.isConnected) window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
    };
  }, [open]);

  useGSAP(() => {
    if (!open || !rootRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.fromTo(rootRef.current.querySelector('.workspace-dialog'), { autoAlpha: 0, y: 10, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: reduceMotion ? 0 : 0.22, ease: 'power2.out' });
  }, { scope: rootRef, dependencies: [open], revertOnUpdate: true });

  if (!open) return null;
  const visibleWorkspace = workspace && (!conversationId || workspace.conversationId === conversationId) ? workspace : undefined;
  const workspaceMismatch = Boolean(workspace && conversationId && workspace.conversationId !== conversationId);
  return createPortal(
    <div ref={rootRef} className="workspace-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title" aria-busy={loading || workspaceMismatch} onPointerDown={event => event.stopPropagation()}>
        <header className="workspace-dialog__header"><div><span className="workspace-dialog__eyebrow">SESSION WORKSPACE</span><h2 id="workspace-dialog-title">当前会话工作区</h2></div><div className="workspace-dialog__header-actions"><button type="button" className="icon-button" onClick={onRefresh} disabled={loading} aria-label="刷新工作区" title="刷新"><RefreshCw size={17} className={loading ? 'workspace-spin' : ''} /></button><button type="button" className="icon-button" onClick={onClose} aria-label="关闭工作区" title="关闭"><X size={19} /></button></div></header>
        {error && <div className="error workspace-error">{error}</div>}
        {loading ? <div className="workspace-loading" role="status" aria-live="polite">正在读取工作区</div> : visibleWorkspace ? <div className="workspace-columns"><FileSection bucket="input" files={visibleWorkspace.input.filter(file => file.bucket === 'input')} onPreview={onPreview} /><FileSection bucket="output" files={visibleWorkspace.output.filter(file => file.bucket === 'output')} onPreview={onPreview} /></div> : <div className="workspace-loading" role={workspaceMismatch ? 'status' : undefined} aria-live={workspaceMismatch ? 'polite' : undefined}>{workspaceMismatch ? '正在同步当前会话工作区' : '暂无工作区内容'}</div>}
      </section>
    </div>,
    document.body
  );
}
