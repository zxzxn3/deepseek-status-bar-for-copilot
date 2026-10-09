// 明细面板图表数据构建：聚合桶 → Chart.js 数据结构。
// 独立模块，detailPanel 只负责 HTML 骨架与 webview 交互，图表数据逻辑与 webview JS 解耦。
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
import { TimeBucket } from "./stats";
import { t } from "./i18n";

// 时间标签一律按 UTC 显示（与统计区间同口径），不随宿主时区变化。
const utcAt = (ts: Date | string | number): dayjs.Dayjs => dayjs.utc(ts);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export type ChartKind = "cost" | "tokens";

/** 交给 webview 里 Chart.js 渲染的数据（时间槽 + 三段堆叠 + 可选余额/耗时线）。 */
export interface ChartPayload {
  labels: string[];
  showTick: boolean[];
  hit: number[];
  miss: number[];
  out: number[];
  format: ChartKind;
  latency: (number | null)[]; // 每槽平均耗时（毫秒），无请求或未开启为 null
  latencyOn: boolean;
  balance: (number | null)[] | { x: number; y: number }[] | null;
  useTimeAxis: boolean; // 余额线是否画在独立线性时间轴（月/全部视图按小时）
  chartStart: number;
  chartEnd: number;
  names: { hit: string; miss: string; out: string; balance: string; latency: string };
}

/** 由聚合桶构建 Chart.js 数据；无数据返回 null（面板显示占位文本）。 */
export function buildChartPayload(
  buckets: TimeBucket[],
  kind: ChartKind,
  barHourly: boolean,
  labelHourly: boolean,
  chartWin: { start: number; end: number },
  balance: { ts: number; cny: number }[],
  showBalance: boolean,
  showLatency: boolean,
  intervalMs?: number,
): ChartPayload | null {
  if (buckets.length === 0) return null;
  const bucketMs = intervalMs ?? (barHourly ? 3600 * 1000 : 24 * 3600 * 1000);
  const slotCount = Math.max(1, Math.ceil((chartWin.end - chartWin.start) / bucketMs));
  const bucketByStart = new Map(buckets.map((b) => [b.start, b]));
  const compactDay = !labelHourly; // 非小时标签的视图（周/月/全部）：标签只显示日号
  const slotLabel = (s: number) => {
    const t = utcAt(s);
    if (intervalMs) return t.format(bucketMs < 86400000 ? "MM-DD HH:mm" : "YYYY-MM-DD");
    if (compactDay) return String(t.date());
    return labelHourly
      ? pad2(t.hour())
      : `${pad2(t.month() + 1)}-${pad2(t.date())}`;
  };
  const isDayStart = (s: number) => {
    const t = utcAt(s);
    return t.hour() === 0 && t.minute() === 0;
  };
  const labelStep = Math.max(1, Math.ceil(slotCount / 24));
  const labels: string[] = [];
  const showTick: boolean[] = [];
  const hit: number[] = [];
  const miss: number[] = [];
  const out: number[] = [];
  const latency: (number | null)[] = [];
  const slotStarts: number[] = [];
  for (let i = 0; i < slotCount; i++) {
    const s = chartWin.start + i * bucketMs;
    const b = bucketByStart.get(s);
    const show =
      intervalMs ? i % Math.max(1, Math.ceil(slotCount / 8)) === 0
      : labelHourly ? i % labelStep === 0
      : barHourly ? isDayStart(s)
      : i % labelStep === 0;
    labels.push(slotLabel(s));
    showTick.push(show);
    if (b) {
      hit.push(kind === "cost" ? b.costCacheHit : b.tokCacheHit);
      miss.push(kind === "cost" ? b.costCacheMiss : b.tokCacheMiss);
      out.push(kind === "cost" ? b.costOutput : b.tokOutput);
      latency.push(showLatency && b.avgMs > 0 ? b.avgMs : null);
    } else {
      hit.push(0);
      miss.push(0);
      out.push(0);
      latency.push(null);
    }
    slotStarts.push(s);
  }
  let balanceVals: (number | null)[] | { x: number; y: number }[] | null = null;
  let useTimeAxis = false;
  if (showBalance && balance.length > 0) {
    if (barHourly || intervalMs) {
      // 天/周视图：柱是小时，余额按小时槽平均，画在 category 轴
      const sums = new Map<number, { sum: number; count: number }>();
      for (const point of balance) {
        if (point.ts < chartWin.start || point.ts >= chartWin.end) continue;
        const index = Math.floor((point.ts - chartWin.start) / bucketMs);
        const value = sums.get(index) ?? { sum: 0, count: 0 };
        value.sum += point.cny;
        value.count++;
        sums.set(index, value);
      }
      const arr = slotStarts.map((_, index) => {
        const value = sums.get(index);
        return value ? value.sum / value.count : null;
      });
      balanceVals = arr;
    } else {
      // 月/全部视图：柱是天，余额按小时点画在独立时间轴 xBal（已与天柱对齐）
      useTimeAxis = true;
      const HOUR = 3600 * 1000;
      const arr: { x: number; y: number }[] = [];
      const first = Math.floor(chartWin.start / HOUR) * HOUR;
      for (let t = first; t < chartWin.end; t += HOUR) {
        let sum = 0;
        let n = 0;
        for (const p of balance) {
          if (p.ts >= t && p.ts < t + HOUR) {
            sum += p.cny;
            n++;
          }
        }
        if (n > 0) arr.push({ x: t, y: sum / n });
      }
      balanceVals = arr;
    }
  }
  return {
    labels,
    showTick,
    hit,
    miss,
    out,
    format: kind,
    latency,
    latencyOn: showLatency,
    balance: balanceVals,
    useTimeAxis,
    chartStart: chartWin.start,
    chartEnd: chartWin.end,
    names: {
      hit: t("cacheHit"),
      miss: t("cacheMiss"),
      out: t("output"),
      balance: t("balanceCurve"),
      latency: t("avgLatency"),
    },
  };
}
