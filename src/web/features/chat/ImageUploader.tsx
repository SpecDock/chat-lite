export default function ImageUploader({ onFile }: { onFile: (file: File) => void }) {
  return <label className="upload" aria-label="上传图片">＋<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} /></label>;
}
