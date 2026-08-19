import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import type { UsageDTO } from '../../../shared/types';
import { api } from '../../shared/api/client';

gsap.registerPlugin(useGSAP);

export type UsageKind = 'token' | 'image';

const copy = {
  image: {
    total: '生图消耗总数',
    chart: '生图消耗'
  }
} satisfies Record<'image', { total: string; chart: string }>;

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? value : 0);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0);
}

function formatCacheRate(value: number | null) {
  return value === null ? '缓存率 --' : `缓存率 ${value.toFixed(1)}%`;
}

function formatShortDate(value: string) {
  const parts = value.split(/[-/]/);
  if (parts.length >= 3) return `${Number(parts[parts.length - 2])}/${Number(parts[parts.length - 1])}`;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function tooltipPosition(index: number, length: number) {
  if (length <= 2) return index === 0 ? 'start' : 'end';
  if (index <= 1) return 'start';
  if (index >= length - 2) return 'end';
  return 'center';
}

export default function UsageDialog({ kind }: { kind: UsageKind }) {
  const [data, setData] = useState<UsageDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [previewDate, setPreviewDate] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartId = useId();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setData(null);
    setSelectedDate(null);
    setPreviewDate(null);
    api.usage()
      .then(result => { if (alive) setData(result); })
      .catch(() => { if (alive) setError('加载失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kind]);

  const tokenDays = useMemo(() => data?.token.days.slice(-7) ?? [], [data]);
  const imageDays = useMemo(() => data?.image.days.slice(-7) ?? [], [data]);
  const tokenMaxValue = Math.max(...tokenDays.map(day => nonNegative(day.inputValue) + nonNegative(day.outputValue)), 0);
  const imageMaxValue = Math.max(...imageDays.map(day => nonNegative(day.value)), 0);
  const daysLength = kind === 'token' ? tokenDays.length : imageDays.length;
  const activeTooltipDate = previewDate ?? selectedDate;

  useGSAP(() => {
    if (loading || error || !daysLength) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = (seconds: number) => reduceMotion ? 0 : seconds;
    const stagger = (seconds: number) => reduceMotion ? 0 : seconds;

    const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } });
    timeline
      .fromTo('.usage-dialog__summary, .usage-dialog__total', { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: duration(0.2) }, 0)
      .fromTo('.usage-dialog__chart', { autoAlpha: 0 }, { autoAlpha: 1, duration: duration(0.22) }, 0.04);

    if (kind === 'token') {
      timeline.fromTo('.usage-dialog__series-key', { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: duration(0.18) }, 0.1);
    }

    timeline
      .fromTo('.usage-dialog__bar-stack', { scaleY: 0, transformOrigin: 'bottom center' }, { scaleY: 1, duration: duration(0.26), stagger: stagger(0.035) }, 0.08)
      .fromTo('.usage-dialog__cache-fill', { scaleY: 0, transformOrigin: 'bottom center' }, { scaleY: 1, duration: duration(0.22), stagger: stagger(0.035) }, 0.16)
      .fromTo('.usage-dialog__bar-value, .usage-dialog__axis-label', { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: duration(0.18), stagger: stagger(0.035) }, 0.25);
  }, { scope: rootRef, dependencies: [daysLength, error, kind, loading], revertOnUpdate: true });

  useGSAP(() => {
    const tooltips = gsap.utils.toArray<HTMLElement>('.usage-dialog__tooltip');
    if (!tooltips.length) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.set(tooltips, { autoAlpha: 0, scale: 0.96, transformOrigin: 'center top' });
    if (!activeTooltipDate) return;

    const activeColumn = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.usage-dialog__column') ?? [])
      .find(column => column.dataset.date === activeTooltipDate);
    const activeTooltip = activeColumn?.querySelector<HTMLElement>('.usage-dialog__tooltip');
    if (activeTooltip) {
      gsap.to(activeTooltip, { autoAlpha: 1, scale: 1, duration: reduceMotion ? 0 : 0.18, ease: 'power2.out' });
    }
  }, { scope: rootRef, dependencies: [activeTooltipDate, daysLength, error, kind, loading], revertOnUpdate: true });

  const tokenSummary = <dl className="usage-dialog__summary" aria-label="token消耗摘要">
    <div className="usage-dialog__metric usage-dialog__metric--input">
      <dt><span className="usage-dialog__metric-mark" aria-hidden="true" />总输入token</dt>
      <dd>
        <span className="usage-dialog__metric-full">{formatNumber(data?.token.inputTotal ?? 0)}</span>
        <span className="usage-dialog__metric-compact">{formatCompactNumber(data?.token.inputTotal ?? 0)}</span>
      </dd>
    </div>
    <div className="usage-dialog__metric usage-dialog__metric--output">
      <dt><span className="usage-dialog__metric-mark" aria-hidden="true" />总输出token</dt>
      <dd>
        <span className="usage-dialog__metric-full">{formatNumber(data?.token.outputTotal ?? 0)}</span>
        <span className="usage-dialog__metric-compact">{formatCompactNumber(data?.token.outputTotal ?? 0)}</span>
      </dd>
    </div>
    <div className="usage-dialog__metric usage-dialog__metric--cached">
      <dt><span className="usage-dialog__metric-mark" aria-hidden="true" />总缓存token</dt>
      <dd>
        <span className="usage-dialog__metric-full">{formatNumber(data?.token.cachedTotal ?? 0)}</span>
        <span className="usage-dialog__metric-compact">{formatCompactNumber(data?.token.cachedTotal ?? 0)}</span>
      </dd>
    </div>
  </dl>;

  const imageSummary = <div className="usage-dialog__total">{copy.image.total}：{formatNumber(data?.image.total ?? 0)}</div>;

  return <div className={`usage-dialog__body usage-dialog__body--${kind}`} ref={rootRef} role="region" aria-label={kind === 'token' ? 'Token统计' : '生图统计'}>
    {loading ? <div className="usage-dialog__state" role="status">加载中</div> : error ? <div className="usage-dialog__state error" role="alert">{error}</div> : daysLength === 0 ? <>
      {kind === 'token' ? tokenSummary : imageSummary}
      <div className="usage-dialog__state">暂无数据</div>
    </> : kind === 'token' ? <>
      {tokenSummary}
      <div className="usage-dialog__series-key" role="group" aria-label="图表图例">
        <span><i className="usage-dialog__series-swatch usage-dialog__series-swatch--input" aria-hidden="true" />输入token</span>
        <span><i className="usage-dialog__series-swatch usage-dialog__series-swatch--output" aria-hidden="true" />输出token</span>
        <span><i className="usage-dialog__series-swatch usage-dialog__series-swatch--cached" aria-hidden="true" />缓存token（输入子集）</span>
      </div>
      <div className="usage-dialog__chart usage-dialog__chart--token" role="list" aria-label={`token消耗，最近${tokenDays.length}天`} style={{ gridTemplateColumns: `repeat(${tokenDays.length}, minmax(0, 1fr))` }}>
        <span className="usage-dialog__plot-grid" aria-hidden="true"><i /><i /><i /></span>
        {tokenDays.map((day, index) => {
          const inputValue = nonNegative(day.inputValue);
          const outputValue = nonNegative(day.outputValue);
          const cachedValue = nonNegative(day.cachedValue);
          const totalValue = inputValue + outputValue;
          const inputPercent = totalValue ? (inputValue / totalValue) * 100 : 0;
          const outputPercent = totalValue ? (outputValue / totalValue) * 100 : 0;
          const totalPercent = tokenMaxValue ? (totalValue / tokenMaxValue) * 100 : 0;
          const cacheRatio = inputValue ? Math.min(Math.max(cachedValue / inputValue, 0), 1) : 0;
          const cachePercent = cacheRatio * inputPercent;
          const shortDate = formatShortDate(day.date);
          const tooltipId = `${chartId}-token-tooltip-${index}`;
          const accessibilityLabel = `日期 ${shortDate}（${day.label}），输入token ${formatNumber(inputValue)}，输出token ${formatNumber(outputValue)}，缓存token ${formatNumber(cachedValue)}，${formatCacheRate(day.cacheRate)}`;

          return <div className="usage-dialog__column-shell" key={day.date} role="listitem">
            <button
              type="button"
              className="usage-dialog__column"
              data-date={day.date}
              data-selected={selectedDate === day.date ? 'true' : undefined}
              data-tooltip-position={tooltipPosition(index, tokenDays.length)}
              aria-label={accessibilityLabel}
              aria-describedby={tooltipId}
              aria-pressed={selectedDate === day.date}
              onClick={() => setSelectedDate(current => current === day.date ? null : day.date)}
              onPointerEnter={() => setPreviewDate(day.date)}
              onPointerLeave={() => setPreviewDate(null)}
              onFocus={() => setPreviewDate(day.date)}
              onBlur={() => setPreviewDate(null)}
            >
              <span className="usage-dialog__bar-track" aria-hidden="true">
                <span className="usage-dialog__bar-stack" style={{ height: `${totalPercent}%` }}>
                  <span className="usage-dialog__bar-segment usage-dialog__bar-segment--input" style={{ height: `${inputPercent}%` }} />
                  <span className="usage-dialog__bar-segment usage-dialog__bar-segment--output" style={{ height: `${outputPercent}%`, bottom: `${inputPercent}%` }} />
                  {cachePercent > 0 && <span className="usage-dialog__cache-fill" style={{ height: `${cachePercent}%` }} />}
                </span>
              </span>
              <span className="usage-dialog__axis-label" aria-hidden="true">{shortDate}</span>
              <span className="usage-dialog__tooltip" id={tooltipId} role="tooltip">
                <strong>日期 {shortDate}</strong>
                <span><b>输入</b>{formatNumber(inputValue)}</span>
                <span><b>输出</b>{formatNumber(outputValue)}</span>
                <span><b>缓存</b>{formatNumber(cachedValue)}</span>
                <span><b>缓存率</b>{day.cacheRate === null ? '--' : `${day.cacheRate.toFixed(1)}%`}</span>
              </span>
            </button>
          </div>;
        })}
      </div>
    </> : <>
      {imageSummary}
      <div className="usage-dialog__chart usage-dialog__chart--image" role="list" aria-label={copy.image.chart} style={{ gridTemplateColumns: `repeat(${imageDays.length}, minmax(0, 1fr))` }}>
        <span className="usage-dialog__plot-grid" aria-hidden="true"><i /><i /><i /></span>
        {imageDays.map((day, index) => {
          const value = nonNegative(day.value);
          const shortDate = formatShortDate(day.date);
          const tooltipId = `${chartId}-image-tooltip-${index}`;
          return <div className="usage-dialog__column-shell" key={day.date} role="listitem">
            <button
              type="button"
              className="usage-dialog__column"
              data-date={day.date}
              data-selected={selectedDate === day.date ? 'true' : undefined}
              data-tooltip-position={tooltipPosition(index, imageDays.length)}
              aria-label={`日期 ${shortDate}（${day.label}），生图消耗 ${formatNumber(value)}`}
              aria-describedby={tooltipId}
              aria-pressed={selectedDate === day.date}
              onClick={() => setSelectedDate(current => current === day.date ? null : day.date)}
              onPointerEnter={() => setPreviewDate(day.date)}
              onPointerLeave={() => setPreviewDate(null)}
              onFocus={() => setPreviewDate(day.date)}
              onBlur={() => setPreviewDate(null)}
            >
              <span className="usage-dialog__bar-value" aria-hidden="true">{formatNumber(value)}</span>
              <span className="usage-dialog__bar-track" aria-hidden="true">
                <span className="usage-dialog__bar-stack usage-dialog__bar-stack--image" style={{ height: `${imageMaxValue ? (value / imageMaxValue) * 100 : 0}%` }}>
                  <span className="usage-dialog__bar-fill" />
                </span>
              </span>
              <span className="usage-dialog__axis-label" aria-hidden="true">{shortDate}</span>
              <span className="usage-dialog__tooltip" id={tooltipId} role="tooltip">
                <strong>日期 {shortDate}</strong>
                <span><b>生图</b>{formatNumber(value)}</span>
              </span>
            </button>
          </div>;
        })}
      </div>
    </>}
  </div>;
}
