import { UPLOAD_ACCEPT, UPLOAD_DESCRIPTION, UPLOAD_HINT } from '../../shared/upload-types';

export default function ImageUploader({ onFile }: { onFile: (file: File) => void }) {
  return <label className="upload" aria-label={`上传${UPLOAD_DESCRIPTION}`} title={UPLOAD_HINT}>＋<input type="file" accept={UPLOAD_ACCEPT} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} /></label>;
}
