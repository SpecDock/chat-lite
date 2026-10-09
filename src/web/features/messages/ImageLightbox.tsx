import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

type Props = { src: string; alt?: string; onClose: () => void };
type Size = { width: number; height: number };
type Point = { x: number; y: number };

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function fittedSize(image: Size, viewport: Size): Size {
  const margin = Math.min(viewport.width, viewport.height) * 0.06;
  const availableWidth = Math.max(1, viewport.width - margin * 2);
  const availableHeight = Math.max(1, viewport.height - margin * 2);
  const fit = Math.min(availableWidth / image.width, availableHeight / image.height);
  return { width: image.width * fit, height: image.height * fit };
}

export default function ImageLightbox({ src, alt = '图片预览', onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const moved = useRef(false);
  const [natural, setNatural] = useState<Size>();
  const [base, setBase] = useState<Size>();
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);

  const measure = () => {
    const viewport = viewportRef.current;
    if (!viewport || !natural) return;
    const rect = viewport.getBoundingClientRect();
    setBase(fittedSize(natural, { width: rect.width, height: rect.height }));
  };

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

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [natural]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      setScale(value => clampScale(value * factor));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  useGSAP(() => {
    if (!rootRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.fromTo(rootRef.current.querySelector('.image-lightbox__stage'),
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: reduceMotion ? 0 : 0.18, ease: 'power2.out' });
  }, { scope: rootRef });

  const copyImage = async () => {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const type = blob.type.startsWith('image/') ? blob.type : 'image/png';
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const pointerPoint = (event: React.PointerEvent): Point => ({ x: event.clientX, y: event.clientY });

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.image-lightbox__actions')) return;
    pointers.current.set(event.pointerId, pointerPoint(event));
    event.currentTarget.setPointerCapture(event.pointerId);
    moved.current = false;
    if (pointers.current.size === 1 && event.button === 0) {
      drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      pinch.current = null;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
      drag.current = null;
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, pointerPoint(event));
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.distance > 0) setScale(clampScale(pinch.current.scale * (distance / pinch.current.distance)));
      moved.current = true;
      return;
    }
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    if (Math.hypot(dx, dy) > 4) moved.current = true;
    setPan({ x: drag.current.panX + dx, y: drag.current.panY + dy });
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const wasDrag = moved.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 1) {
      const [point] = [...pointers.current.values()];
      drag.current = { x: point.x, y: point.y, panX: pan.x, panY: pan.y };
    } else {
      drag.current = null;
    }
    if (!wasDrag && event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      className="image-lightbox"
      role="presentation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <div className="image-lightbox__actions">
        <button type="button" className="icon-button" onClick={copyImage} aria-label={copied ? '已复制' : '复制图片'} title={copied ? '已复制' : '复制'}>{copied ? <Check size={18} /> : <Copy size={18} />}</button>
        <a className="icon-button" href={`${src}${src.includes('?') ? '&' : '?'}download=1`} download aria-label="下载图片" title="下载"><Download size={18} /></a>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭预览" title="关闭"><X size={19} /></button>
      </div>
      <div ref={viewportRef} className="image-lightbox__viewport">
        <img
          className="image-lightbox__stage"
          src={src}
          alt={alt}
          draggable={false}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={base ? { width: base.width, height: base.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` } : undefined}
        />
      </div>
    </div>,
    document.body
  );
}
