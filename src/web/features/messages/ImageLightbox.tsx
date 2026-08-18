import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

type Props = { src: string; alt?: string; onClose: () => void };

export default function ImageLightbox({ src, alt = '图片预览', onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useGSAP(() => {
    if (!rootRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.fromTo(rootRef.current.querySelector('.image-lightbox__panel'),
      { autoAlpha: 0, scale: 0.97, y: 8 },
      { autoAlpha: 1, scale: 1, y: 0, duration: reduceMotion ? 0 : 0.2, ease: 'power2.out' });
  }, { scope: rootRef });

  const adjustScale = (delta: number) => setScale(value => Math.min(4, Math.max(0.5, Number((value + delta).toFixed(2)))));

  return createPortal(
    <div ref={rootRef} className="image-lightbox" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="image-lightbox__panel" role="dialog" aria-modal="true" aria-label="图片预览" onPointerDown={event => event.stopPropagation()}>
        <header className="image-lightbox__toolbar">
          <span className="image-lightbox__title">{alt}</span>
          <div className="image-lightbox__actions">
            <button type="button" className="icon-button" onClick={() => adjustScale(-0.25)} aria-label="缩小" title="缩小"><ZoomOut size={18} /></button>
            <button type="button" className="icon-button" onClick={() => setScale(1)} aria-label="重置缩放" title="重置缩放"><RotateCcw size={17} /></button>
            <button type="button" className="icon-button" onClick={() => adjustScale(0.25)} aria-label="放大" title="放大"><ZoomIn size={18} /></button>
            <a className="icon-button" href={`${src}${src.includes('?') ? '&' : '?'}download=1`} download aria-label="下载图片" title="下载"><Download size={18} /></a>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭预览" title="关闭"><X size={19} /></button>
          </div>
        </header>
        <div className="image-lightbox__viewport" onWheel={event => { event.preventDefault(); adjustScale(event.deltaY > 0 ? -0.15 : 0.15); }}>
          <img src={src} alt={alt} draggable={false} style={{ transform: `scale(${scale})` }} />
        </div>
      </section>
    </div>,
    document.body
  );
}
