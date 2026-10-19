import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../../shared/api/client';
import { FileTypeIcon } from '../messages/fileTypeIcon';
import ImageLightbox from '../messages/ImageLightbox';

type CloudFile = { id: string; name: string; mimeType: string; size: number; createdAt: string; kind: string; url: string; downloadUrl: string; preview: boolean };

function formatCloudDate(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function CloudFilesDialog() {
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(2 * 1024 * 1024 * 1024);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api.cloudFiles().then(result => {
      if (!alive) return;
      setUsed(result.used);
      setLimit(result.limit || limit);
      setFiles(result.files || []);
    }).catch(cause => {
      if (alive) setError(cause instanceof Error ? cause.message : '云文件加载失败');
    });
    return () => { alive = false; };
  }, []);

  const ratio = limit > 0 ? Math.min(100, used / limit * 100) : 0;
  return <div className="cloud-files">
    <div className="cloud-files__meter" aria-label={`已使用 ${formatBytes(used)}，共 ${formatBytes(limit)}`}>
      <div className="cloud-files__meter-bar"><span style={{ width: `${ratio}%` }} /></div>
      <small>{formatBytes(used)} / {formatBytes(limit)}</small>
    </div>
    {error && <div className="error">{error}</div>}
    <div className="cloud-files__list">
      {files.length === 0 && !error ? <p className="cloud-files__empty">还没有文件</p> : files.map(file => <div className="cloud-files__row" key={`${file.kind}:${file.id}`}>
        <button type="button" className="cloud-files__main" disabled={!file.preview} onClick={() => file.preview && setPreview({ src: file.url, alt: file.name })}>
          <FileTypeIcon name={file.preview ? file.name + '.png' : file.name} size={28} />
          <span><strong>{file.name}</strong><small>{formatBytes(file.size)}{formatCloudDate(file.createdAt) ? ` · ${formatCloudDate(file.createdAt)}` : ''}</small></span>
        </button>
        <a className="icon-button" href={file.downloadUrl} download aria-label={`下载 ${file.name}`} title="下载"><Download size={16} /></a>
      </div>)}
    </div>
    {preview && <ImageLightbox src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />}
  </div>;
}
