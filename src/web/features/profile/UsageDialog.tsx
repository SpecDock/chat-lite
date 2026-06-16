import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import type { UsageDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';

export type UsageKind = 'token' | 'image';

const copy = {
  token: {
    total: '消耗token总数',
    chart: 'token消耗'
  },
  image: {
    total: '生图消耗总数',
    chart: '生图消耗'
  }
} satisfies Record<UsageKind, { total: string; chart: string }>;

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

export default function UsageDialog({ kind }: { kind: UsageKind }) {
  const [data, setData] = useState<UsageDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setData(null);
    api.usage()
      .then(result => { if (alive) setData(result); })
      .catch(() => { if (alive) setError('加载失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kind]);

  const days = useMemo(() => data ? data[kind].days.slice(-7) : [], [data, kind]);
  const total = data ? data[kind].total : 0;
  const maxValue = Math.max(...days.map(day => day.value), 1);

  useEffect(() => {
    if (loading || error || !days.length || !rootRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo('.usage-dialog__total', { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: 0.18, ease: 'power2.out' });
      gsap.fromTo('.usage-dialog__bar-fill', { scaleY: 0 }, { scaleY: 1, duration: 0.42, ease: 'power2.out', stagger: 0.045, delay: 0.04 });
      gsap.fromTo('.usage-dialog__axis-label', { autoAlpha: 0, y: 5 }, { autoAlpha: 1, y: 0, duration: 0.2, ease: 'power2.out', stagger: 0.035, delay: 0.12 });
    }, rootRef);
    return () => ctx.revert();
  }, [days.length, error, kind, loading]);

  return <div className="usage-dialog__body" ref={rootRef}>
    {loading ? <div className="usage-dialog__state" role="status">加载中</div> : error ? <div className="usage-dialog__state error">{error}</div> : days.length === 0 ? <>
      <div className="usage-dialog__total">{copy[kind].total}：{formatNumber(total)}</div>
      <div className="usage-dialog__state">暂无数据</div>
    </> : <>
      <div className="usage-dialog__total">{copy[kind].total}：{formatNumber(total)}</div>
      <div className="usage-dialog__chart" aria-label={copy[kind].chart} style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map(day => <div className="usage-dialog__column" key={day.date} title={`${day.label} ${formatNumber(day.value)}`}>
          <div className="usage-dialog__bar-track" aria-label={`${day.label} ${formatNumber(day.value)}`}>
            <div className="usage-dialog__bar-fill" style={{ height: `${Math.max(8, (day.value / maxValue) * 100)}%` }} />
          </div>
          <span className="usage-dialog__axis-label">{day.label}</span>
        </div>)}
      </div>
    </>}
  </div>;
}
