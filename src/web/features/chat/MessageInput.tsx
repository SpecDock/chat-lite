import { useEffect, useState } from 'react';
import type { AttachmentDTO } from '../../../shared/types';
import ImageUploader from './ImageUploader';

export default function MessageInput({ disabled, sending, refillText, refillKey, pending, onSend, onCancel, onImage, onRemoveImage }: { disabled?: boolean; sending?: boolean; refillText?: string; refillKey?: number; pending: AttachmentDTO[]; onSend: (text: string) => void; onCancel?: () => void; onImage: (file: File) => void | Promise<void>; onRemoveImage: (id: string) => void }) {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const hasContent = Boolean(text.trim() || pending.length);
  useEffect(() => {
    if (refillText !== undefined) setText(refillText);
  }, [refillText, refillKey]);
  const addFiles = (files: FileList | File[]) => {
    Array.from(files).filter(file => file.type.startsWith('image/')).forEach(file => void onImage(file));
  };
  const submit = () => {
    if (sending) { onCancel?.(); return; }
    const v = text.trim();
    if (v || pending.length) { onSend(v); setText(''); }
  };
  return <form
    className={dragging ? 'composer dragging' : 'composer'}
    onSubmit={e => { e.preventDefault(); submit(); }}
    onPaste={e => {
      const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    }}
    onDragOver={e => { e.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
  >
    {pending.length > 0 && <div className="pending-images">{pending.map(a => <button type="button" key={a.id} aria-label="移除图片" onClick={() => onRemoveImage(a.id)}><img src={a.public_path} alt={a.original_name} /><span>×</span></button>)}</div>}
    <div className="input"><ImageUploader onFile={onImage} /><textarea rows={1} placeholder="输入消息，或粘贴/拖入图片" value={text} disabled={disabled && !sending} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !sending) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} /><button className={sending ? 'send-button sending' : 'send-button'} type="submit" disabled={!sending && (disabled || !hasContent)} aria-label={sending ? '取消生成' : '发送消息'}>{sending ? <><span className="send-spinner" aria-hidden="true" />取消</> : '发送'}</button></div>
  </form>;
}
