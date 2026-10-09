// 今日（UTC）统计聚合。JSONL 存原始事实，费用在此按峰值现算。
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { UsageRecord } from "./jsonl";
import { modelPrice, costFromUsage, isPeak } from "./pricing";

dayjs.extend(utc);

export interface TodayStats {
  p: number;
  c: number;
  t: number;
  ch: number;
  cost: number;
  chCost: number;
}

// 全部时间窗按 UTC 对齐：与 DeepSeek 官方高峰时段同口径，且不随宿主/用户时区漂移。
const utcAt = (ts: Date | string | number): dayjs.Dayjs => dayjs.utc(ts);

/** UTC 当天 0 点对应的毫秒。 */
export function utcDayStartMs(now: Date): number {
  return utcAt(now).startOf("day").valueOf();
}

export function newTodayStats(): TodayStats {
  return { p: 0, c: 0, t: 0, ch: 0, cost: 0, chCost: 0 };
}

/** 任意时刻记录的计价结果（不含"今天"门控），供任意区间聚合用。 */
function costsAt(
  r: UsageRecord,
  tsMs: number,
): {
  pt: number;
  ct: number;
  tt: number;
  ch: number;
  cm: number;
  cost: number;
  chCost: number;
  cmCost: number;
  outCost: number;
} {
  const pt = r.prompt_tokens ?? 0;
  const ct = r.completion_tokens ?? 0;
  const tt = r.total_tokens ?? 0;
  const ch = r.cache_hit_tokens ?? 0;
  const cm = r.cache_miss_tokens ?? 0;
  const peak = isPeak(tsMs);
  const f = peak ? 2 : 1;
  const cost = costFromUsage(pt, ct, ch, cm, r.model, peak, tsMs);
  const pr = modelPrice(r.model, tsMs);
  return {
    pt,
    ct,
    tt,
    ch,
    cm,
    cost,
    chCost: (ch * pr.cache_hit) / 1e6 * f,
    cmCost: (cm * pr.cache_miss) / 1e6 * f,
    outCost: (ct * pr.output) / 1e6 * f,
  };
}

export interface ModelStats {
  p: number;
  c: number;
  t: number;
  ch: number;
  cost: number;
  chCost: number;
  count: number;
  avgMs: number; // 该模型请求平均耗时（毫秒）
  sumMs?: number; // 内部累计用，返回前删除
  countMs?: number;
}

export function newModelStats(): ModelStats {
  return { p: 0, c: 0, t: 0, ch: 0, cost: 0, chCost: 0, count: 0, avgMs: 0 };
}

// ---------------------------------------------------------------------------
// 任意区间聚合（today / week / month / all），供明细面板使用
// ---------------------------------------------------------------------------
export type RangeKey = "today" | "week" | "month" | "all";
export type PanelRange = RangeKey | "custom";
export const RANGE_KEYS: RangeKey[] = ["today", "week", "month", "all"];
export type CustomMode = "day" | "week" | "month";

/** 区间窗口（UTC）：day=今日一整天；week/month=自然周/月整段（含未来空槽，图轴稳定）；all=全部。 */
export function rangeWindow(
  key: RangeKey,
  now = new Date(),
): { start: number; end: number } {
  const DAY = 24 * 3600 * 1000;
  const dayStart = utcDayStartMs(now);
  switch (key) {
    case "today":
      return { start: dayStart, end: dayStart + DAY };
    case "week": {
      const wd = utcAt(dayStart).day(); // UTC 星期几，周日=0
      const weekStart = dayStart - ((wd + 6) % 7) * DAY;
      return { start: weekStart, end: weekStart + 7 * DAY };
    }
    case "month": {
      const m = utcAt(dayStart);
      return {
        start: m.startOf("month").valueOf(),
        end: m.add(1, "month").startOf("month").valueOf(),
      };
    }
    case "all":
      return { start: 0, end: now.getTime() };
  }
}

/** "全部"图表的时间跨度：从最早记录的 UTC 日开始，到今晚结束（避免 1970 年起画海量空槽）。 */
export function allChartWindow(
  records: UsageRecord[],
  now = new Date(),
): { start: number; end: number } {
  const DAY = 24 * 3600 * 1000;
  let minTs = now.getTime();
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t < minTs) minTs = t;
  }
  return {
    start: utcDayStartMs(new Date(minTs)),
    end: utcDayStartMs(now) + DAY,
  };
}

/** UTC 某日历日 0 点对应的毫秒。dateStr = YYYY-MM-DD。 */
export function utcDateStartMs(dateStr: string): number {
  return utcAt(dateStr).startOf("day").valueOf();
}

/** 自定义区间窗口：day=该 UTC 日；week=该日所在周（周一~周日）；month=该日所在月。 */
export function customRangeWindow(
  dateStr: string,
  mode: CustomMode,
): { start: number; end: number } {
  const DAY = 24 * 3600 * 1000;
  const dayStart = utcDateStartMs(dateStr);
  if (mode === "day") return { start: dayStart, end: dayStart + DAY };
  if (mode === "week") {
    const wd = utcAt(dayStart).day(); // UTC 星期几，周日=0
    const weekStart = dayStart - ((wd + 6) % 7) * DAY;
    return { start: weekStart, end: weekStart + 7 * DAY };
  }
  const m = utcAt(dayStart);
  return {
    start: m.startOf("month").valueOf(),
    end: m.add(1, "month").startOf("month").valueOf(),
  };
}

export interface TimeBucket {
  label: string; // 今天=HH，其它=MM-DD（UTC）
  start: number; // 桶起点（UTC ms）
  cost: number;
  tokens: number;
  // 堆叠分量（费用元 / 词元）：缓存命中·缓存未命中·输出
  costCacheHit: number;
  costCacheMiss: number;
  costOutput: number;
  tokCacheHit: number;
  tokCacheMiss: number;
  tokOutput: number;
  avgMs: number; // 该桶内请求平均耗时（毫秒）
  sumMs?: number; // 内部累计用，返回前删除
  countMs?: number;
}

export interface RangeStats {
  p: number;
  c: number;
  t: number;
  ch: number;
  cost: number;
  chCost: number;
  count: number;
  count402: number; // 区间内 402（余额不足）请求数
  avgMs: number; // 请求平均耗时（毫秒，仅统计带 ms 的记录）
  maxMs: number; // 最慢请求耗时（毫秒）
  models: { name: string; m: ModelStats }[];
  recent: UsageRecord[]; // 区间内最近 60 条（新→旧）
  rows: UsageRecord[]; // 区间内全部（新→旧），供 CSV 导出
  buckets: TimeBucket[]; // 时间桶：今天按小时，其余按天
}

/** 聚合任意区间：汇总 + 按模型 + 最近请求 + 时间桶。 */
export function aggregateWindow(
  records: UsageRecord[],
  start: number,
  end: number,
  hourly: boolean | number,
): RangeStats {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const bucketMs = typeof hourly === "number" ? hourly : hourly ? HOUR : DAY;

  const stats = newTodayStats();
  const modelMap = new Map<string, ModelStats>();
  const rows: UsageRecord[] = [];
  const bucketMap = new Map<number, TimeBucket>();
  let count402 = 0;
  let sumMs = 0;
  let countMs = 0;
  let maxMs = 0;

  const bucketLabel = (ms: number) => {
    const t = utcAt(ms);
    if (hourly) return String(t.hour()).padStart(2, "0");
    return `${String(t.month() + 1).padStart(2, "0")}-${String(
      t.date(),
    ).padStart(2, "0")}`;
  };

  for (const r of records) {
    const tsMs = Date.parse(r.ts);
    if (!Number.isFinite(tsMs) || tsMs < start || tsMs >= end) continue;
    if (r.status === 402) count402 += 1;
    const rms = r.ms;
    const rmsOk = typeof rms === "number" && Number.isFinite(rms) && rms >= 0;
    if (rmsOk) {
      sumMs += rms;
      countMs += 1;
      if (rms > maxMs) maxMs = rms;
    }
    const c = costsAt(r, tsMs);

    stats.p += c.pt;
    stats.c += c.ct;
    stats.t += c.tt;
    stats.ch += c.ch;
    stats.cost += c.cost;
    stats.chCost += c.chCost;

    let m = modelMap.get(r.model);
    if (!m) {
      m = newModelStats();
      modelMap.set(r.model, m);
    }
    m.p += c.pt;
    m.c += c.ct;
    m.t += c.tt;
    m.ch += c.ch;
    m.cost += c.cost;
    m.chCost += c.chCost;
    m.count += 1;
    if (rmsOk) {
      m.sumMs = (m.sumMs ?? 0) + rms;
      m.countMs = (m.countMs ?? 0) + 1;
    }

    rows.push(r);

    // 桶按 UTC 对齐（当天 00:00 / 整点），与图表完整时间轴一致。
    const bStart = typeof hourly === "number"
      ? start + Math.floor((tsMs - start) / bucketMs) * bucketMs
      : utcAt(tsMs).startOf(hourly ? "hour" : "day").valueOf();
    let b = bucketMap.get(bStart);
    if (!b) {
      b = {
        label: bucketLabel(bStart),
        start: bStart,
        cost: 0,
        tokens: 0,
        costCacheHit: 0,
        costCacheMiss: 0,
        costOutput: 0,
        tokCacheHit: 0,
        tokCacheMiss: 0,
        tokOutput: 0,
        avgMs: 0,
      };
      bucketMap.set(bStart, b);
    }
    b.cost += c.cost;
    b.tokens += c.tt;
    b.costCacheHit += c.chCost;
    b.costCacheMiss += c.cmCost;
    b.costOutput += c.outCost;
    b.tokCacheHit += c.ch;
    b.tokCacheMiss += c.cm;
    b.tokOutput += c.ct;
    if (rmsOk) {
      b.sumMs = (b.sumMs ?? 0) + rms;
      b.countMs = (b.countMs ?? 0) + 1;
    }
  }

  rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const buckets = [...bucketMap.values()].sort((a, b) =>
    a.start - b.start,
  );
  for (const b of buckets) {
    b.avgMs = b.countMs ? Math.round((b.sumMs ?? 0) / b.countMs) : 0;
    delete b.sumMs;
    delete b.countMs;
  }

  return {
    p: stats.p,
    c: stats.c,
    t: stats.t,
    ch: stats.ch,
    cost: stats.cost,
    chCost: stats.chCost,
    count: rows.length,
    count402,
    avgMs: countMs ? Math.round(sumMs / countMs) : 0,
    maxMs,
    models: [...modelMap.entries()].map(([name, m]) => {
      m.avgMs = m.countMs ? Math.round((m.sumMs ?? 0) / m.countMs) : 0;
      delete m.sumMs;
      delete m.countMs;
      return { name, m };
    }),
    recent: rows.slice(0, 200),
    rows,
    buckets,
  };
}

/** 快捷区间（today/week/month/all）聚合。 */
export function aggregateRange(
  records: UsageRecord[],
  key: RangeKey,
  now = new Date(),
): RangeStats {
  const { start, end } = rangeWindow(key, now);
  // 天/周视图按小时柱；月/全部按天柱
  return aggregateWindow(records, start, end, key === "today" || key === "week");
}

/** 自定义日期聚合：day=该日（按小时桶）；week/month=按天桶。 */
export function aggregateCustom(
  records: UsageRecord[],
  dateStr: string,
  mode: CustomMode,
): RangeStats {
  const { start, end } = customRangeWindow(dateStr, mode);
  // 天/周自定义视图按小时柱；月按天柱
  return aggregateWindow(records, start, end, mode === "day" || mode === "week");
}
