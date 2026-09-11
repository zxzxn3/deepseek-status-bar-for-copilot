// 官方定价表与费用计算（DeepSeek，按请求时间取价）。
// - 高峰价 = 空闲价 × 2；高峰 = 北京时间周一~五 9-12、14-18。
// - 单位：元 / 百万 tokens。

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

export interface ModelPrice {
  cache_hit: number; // 输入缓存命中
  cache_miss: number; // 输入未命中
  output: number;
}

export const DEFAULT_MODEL = "deepseek-flash";

interface PriceTier {
  readonly fromUtcMs: number;
  readonly set: Readonly<Record<string, Readonly<ModelPrice>>>;
}
const F = (cache_hit: number, cache_miss: number, output: number): ModelPrice =>
  ({ cache_hit, cache_miss, output });

// 空闲价（元 / 百万 tokens），高峰 ×2。
// 官方来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
export const SCHEDULE: readonly PriceTier[] = [
  // 初始档沿用仓库 2026-08-03 的价目表，更早历史暂无其它档位。
  { fromUtcMs: 0, set: {
    "deepseek-v4-flash": F(0.05, 1.5, 4.5),
    "deepseek-v4-flash-vision-exp": F(0.05, 1.5, 4.5),
    "deepseek-v4-pro": F(0.15, 4.5, 13.5),
  } },
  // 价格及别名经官网核实；生效时刻来自交接文档中的用户信息，官网未注明。
  { fromUtcMs: Date.parse("2026-09-10T12:00:00+08:00"), set: {
    "deepseek-flash": F(0.02, 1, 4),
    "deepseek-v4-flash": F(0.02, 1, 4),
    "deepseek-v4-flash-vision-exp": F(0.02, 1, 4),
  } },
  // 官网：此时起 Pro 路由到 V4.1 Flash，按 Flash 价计费。
  { fromUtcMs: Date.parse("2026-09-14T12:00:00+08:00"), set: {
    "deepseek-v4-pro": F(0.02, 1, 4),
  } },
];

// 将来 DeepSeek 再调价时：
// 1. 打开 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/，核实当前价与生效时刻（北京时间）。
// 2. 在 SCHEDULE 末尾追加一档：{ fromUtcMs: Date.parse("YYYY-MM-DDTHH:mm:00+08:00"), set: { /* 只写发生变化的模型 */ } }。
// 3. 同步 README.md / README_zh.md 的 Pricing 段。
// 4. 在 test.ts 加一条该时间点的边界断言。
// 5. 若出现新模型 id：同步 src/server/termfmt.ts::MODEL_SHORT 与 README 的模型列表。
// usage.jsonl 不需要迁移，每条记录按自己的时间点取价。

export type PriceOverrides = Record<string, Partial<ModelPrice>>;

let overrides: PriceOverrides = {};

/** 覆盖作用于所有历史及未来档位；无参数时清除覆盖。 */
export function setPriceOverrides(o?: PriceOverrides): void {
  overrides = Object.fromEntries(Object.entries(o ?? {}).map(([m, p]) => [m, { ...p }]));
}

/** 按时间累计官方档位，再合并覆盖；返回独立副本，避免调用方修改内置价格。 */
export function effectiveTable(tsMs = Date.now()): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = Object.create(null);
  for (const tier of SCHEDULE) {
    if (tier.fromUtcMs > tsMs) break;
    for (const [m, p] of Object.entries(tier.set)) table[m] = { ...p };
  }
  const fallback = table[DEFAULT_MODEL] ?? table["deepseek-v4-flash"] ?? SCHEDULE[0].set["deepseek-v4-flash"];
  for (const [m, p] of Object.entries(overrides)) {
    table[m] = { ...(table[m] ?? fallback), ...p };
  }
  return table;
}

/** 取某模型生效价；早期记录缺少新模型名时回退旧 Flash。 */
export function modelPrice(model: string, tsMs = Date.now()): ModelPrice {
  const table = effectiveTable(tsMs);
  return table[model] ?? table[DEFAULT_MODEL] ?? table["deepseek-v4-flash"] ?? { ...SCHEDULE[0].set["deepseek-v4-flash"] };
}

// 北京时间用 dayjs 的 UTC 模式偏移表示（字段即北京值，不受宿主时区影响）
const bj = (ts: Date | string | number): dayjs.Dayjs =>
  dayjs.utc(ts).add(8, "hour");

/** tsUtc（Date 或 ISO 字符串）是否落在北京时间高峰时段（周一~五 9-12、14-18）。 */
export function isPeakBeijing(tsUtc: Date | string): boolean {
  const bt = bj(tsUtc);
  const wd = bt.day(); // Sun=0..Sat=6
  const h = bt.hour();
  if (wd === 0 || wd === 6) return false; // 周六/周日
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

export interface PeakSegment {
  peak: boolean;
  range: string; // 北京时间当前计费段，如 "09:00-12:00"
}

/** 北京时间当前所处计费段：高峰=周一~五 9-12、14-18，其余闲时。 */
export function currentBeijingSegment(tsUtc: Date | string): PeakSegment {
  const bt = bj(tsUtc);
  const wd = bt.day();
  const hm = bt.hour() + bt.minute() / 60;
  if (wd === 0 || wd === 6) return { peak: false, range: "00:00-24:00" };
  if (hm >= 9 && hm < 12) return { peak: true, range: "09:00-12:00" };
  if (hm >= 12 && hm < 14) return { peak: false, range: "12:00-14:00" };
  if (hm >= 14 && hm < 18) return { peak: true, range: "14:00-18:00" };
  if (hm >= 18) return { peak: false, range: "18:00-24:00" };
  // 凌晨属于跨夜闲时段：前一天 18:00 开始，至今早 09:00
  return { peak: false, range: "18:00-09:00" };
}

/** 精确 usage 计费；peak=True 按高峰价 ×2。返回本次请求费用（元）。 */
export function costFromUsage(
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens: number,
  cacheMissTokens: number,
  model = DEFAULT_MODEL,
  peak = false,
  tsMs = Date.now(),
): number {
  const p = modelPrice(model, tsMs);
  const f = peak ? 2.0 : 1.0;
  return (
    (cacheMissTokens * p.cache_miss +
      cacheHitTokens * p.cache_hit +
      completionTokens * p.output) /
      1e6 *
    f
  );
}
