import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { UsageDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';

gsap.registerPlugin(useGSAP);

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

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

function formatCacheRate(value: number | null) {
  return value === null ? '缓存 --' : `缓存 ${value.toFixed(1)}%`;
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

  const tokenDays = useMemo(() => data ? data.token.days.slice(-7) : [], [data]);
  const imageDays = useMemo(() => data ? data.image.days.slice(-7) : [], [data]);
  const days = kind === 'token' ? tokenDays : imageDays;
  const total = data ? data[kind].total : 0;
  const cachedTotal = data?.token.cachedTotal ?? 0;
  const maxValue = Math.max(...days.map(day => day.value), 1);

  useGSAP(() => {
    if (loading || error || !days.length) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = (seconds: number) => reduceMotion ? 0 : seconds;
    const position = (seconds: number) => reduceMotion ? 0 : seconds;
    const stagger = (seconds: number) => reduceMotion ? 0 : seconds;

    const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
    timeline.fromTo('.usage-dialog__summary, .usage-dialog__total', { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: duration(0.18) }, 0);

    if (kind === 'token') {
      timeline.fromTo('.usage-dialog__series-key', { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: duration(0.18) }, position(0.12));
      timeline.fromTo('.usage-dialog__cache-fill', { scaleY: 0, transformOrigin: 'bottom center' }, { scaleY: 1, duration: duration(0.22), stagger: stagger(0.04) }, position(0.18));
    }

    timeline
      .fromTo('.usage-dialog__bar-fill', { scaleY: 0, transformOrigin: 'bottom center' }, { scaleY: 1, duration: duration(0.26), stagger: stagger(0.04) }, position(0.08))
      .fromTo('.usage-dialog__bar-copy, .usage-dialog__bar-value', { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: duration(0.18), stagger: stagger(0.035) }, position(0.28))
      .fromTo('.usage-dialog__axis-label', { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: duration(0.18), stagger: stagger(0.035) }, position(0.3));
  }, { scope: rootRef, dependencies: [days.length, error, kind, loading], revertOnUpdate: true });

  const summary = kind === 'token' ? <dl className="usage-dialog__summary" aria-label="token消耗摘要">
    <div className="usage-dialog__metric usage-dialog__metric--total">
      <dt><span className="usage-dialog__metric-mark" aria-hidden="true" />消耗token总数</dt>
      <dd>{formatNumber(total)}</dd>
    </div>
    <div className="usage-dialog__metric usage-dialog__metric--cached">
      <dt><span className="usage-dialog__metric-mark" aria-hidden="true" />缓存token总数</dt>
      <dd>{formatNumber(cachedTotal)}</dd>
    </div>
  </dl> : <div className="usage-dialog__total">{copy.image.total}：{formatNumber(total)}</div>;

  return <div className={`usage-dialog__body usage-dialog__body--${kind}`} ref={rootRef}>
    {loading ? <div className="usage-dialog__state" role="status">加载中</div> : error ? <div className="usage-dialog__state error">{error}</div> : days.length === 0 ? <>
      {summary}
      <div className="usage-dialog__state">暂无数据</div>
    </> : kind === 'token' ? <>
      {summary}
      <div className="usage-dialog__series-key" aria-label="图表系列">
        <span><i className="usage-dialog__series-swatch usage-dialog__series-swatch--total" aria-hidden="true" />总token</span>
        <span><i className="usage-dialog__series-swatch usage-dialog__series-swatch--cached" aria-hidden="true" />缓存token</span>
      </div>
      <div className="usage-dialog__chart usage-dialog__chart--token" role="list" aria-label={`token消耗，最近${tokenDays.length}个有token使用的日期`} style={{ gridTemplateColumns: `repeat(${tokenDays.length}, minmax(0, 1fr))` }}>
        {tokenDays.map(day => {
          const cacheRateLabel = formatCacheRate(day.cacheRate);
          const accessibilityLabel = `日期 ${day.date}（${day.label}），总token ${formatNumber(day.value)}，缓存token ${formatNumber(day.cachedValue)}，${day.cacheRate === null ? '缓存率无数据' : `缓存率 ${day.cacheRate.toFixed(1)}%`}`;
          const cachedHeight = day.cachedValue === 0 ? 0 : (Math.min(day.cachedValue, day.value) / maxValue) * 100;
          return <div className="usage-dialog__column" key={day.date} role="listitem" aria-label={accessibilityLabel} title={accessibilityLabel}>
            <span className="usage-dialog__bar-copy" aria-hidden="true">
              <span className="usage-dialog__bar-total">{formatCompactNumber(day.value)}</span>
              <span className="usage-dialog__bar-cache-rate">{cacheRateLabel}</span>
            </span>
            <div className="usage-dialog__bar-track" aria-hidden="true">
              <div className="usage-dialog__bar-fill" style={{ height: `${Math.max(8, (day.value / maxValue) * 100)}%` }} />
              <div className="usage-dialog__cache-fill" style={{ height: `${cachedHeight}%` }} />
            </div>
            <span className="usage-dialog__axis-label" aria-hidden="true">{day.label}</span>
          </div>;
        })}
      </div>
    </> : <>
      {summary}
      <div className="usage-dialog__chart" aria-label={copy.image.chart} style={{ gridTemplateColumns: `repeat(${imageDays.length}, minmax(0, 1fr))` }}>
        {imageDays.map(day => <div className="usage-dialog__column" key={day.date} title={`${day.label} ${formatNumber(day.value)}`}>
          <span className="usage-dialog__bar-value">{formatNumber(day.value)}</span>
          <div className="usage-dialog__bar-track" aria-label={`${day.label} ${formatNumber(day.value)}`}>
            <div className="usage-dialog__bar-fill" style={{ height: `${Math.max(8, (day.value / maxValue) * 100)}%` }} />
          </div>
          <span className="usage-dialog__axis-label">{day.label}</span>
        </div>)}
      </div>
    </>}
  </div>;
}
