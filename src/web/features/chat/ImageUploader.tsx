export default function ImageUploader({ onFile }: { onFile: (file: File) => void }) {
  return <label className="upload" aria-label="上传图片或表格">＋<input type="file" accept="image/jpeg,image/png,image/webp,.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} /></label>;
}
