// 官方定价表与费用计算（DeepSeek，按请求时间取价）。
// - 高峰价 = 空闲价 × 2；高峰 = UTC 周一~五 01:00-04:00、06:00-10:00
//   （官方英文价目表的 UTC 口径，等同北京时间 09:00-12:00、14:00-18:00）。
// - 高峰时段不含中国法定节假日（官方价目表脚注），放假按北京日历日整天算；
//   调休上班日（周末但官方要求上班）仍按工作日计高峰。
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
  // V4.1-Flash 上线价：Flash 空闲 0.02/1/4；旧模型名路由到 V4.1-Flash 并按 Flash 价计费。
  // 官方更新日志 2026-09-10 只给出日期，具体时刻沿用 12:00（北京）。
  { fromUtcMs: Date.parse("2026-09-10T12:00:00+08:00"), set: {
    "deepseek-flash": F(0.02, 1, 4),
    "deepseek-v4-flash": F(0.02, 1, 4),
    "deepseek-v4-flash-vision-exp": F(0.02, 1, 4),
  } },
  // deepseek-v4-pro 不进此表：官方价目表仍单列该模型（空闲 0.15/4.5/13.5），
  // 2026-09-10 更新日志亦明确「9 月 14 日之后继续提供 V4 Pro，计费方式保持不变」。
];

// 将来 DeepSeek 再调价时：
// 1. 打开 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/，核实当前价与生效时刻。
// 2. 在 SCHEDULE 末尾追加一档：{ fromUtcMs: Date.parse("YYYY-MM-DDTHH:mm:00Z"), set: { /* 只写发生变化的模型 */ } }。
// 3. 同步 README.md / README_zh.md 的 Pricing 段。
// 4. 在 test.ts 加一条该时间点的边界断言。
// 5. 若出现新模型 id：同步 src/server/termfmt.ts::MODEL_SHORT 与 README 的模型列表。
// 6. 每年国务院办公厅公布次年放假安排后，更新 DEFAULT_HOLIDAYS / DEFAULT_ADDITIONAL_WORKDAYS，
//    以及 package.json 里两个同名设置的默认值（test.ts 会断言两者一致）。
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

// 时间一律按 UTC 读取：deepseek-* 字段本身就是 UTC 时刻，不随宿主时区变化。
// 官方价目表用北京时间给出高峰时段，英文版换算成 UTC 口径（01:00-04:00、06:00-10:00）。

/** 高峰时段（UTC，官方口径）。 */
const PEAK_WINDOWS: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

// 中国法定节假日（2026 年）：国务院办公厅《关于 2026 年部分节假日安排的通知》
// 国办发明电〔2025〕7 号 https://www.gov.cn/zhengce/content/202511/content_7047090.htm
// 放假调休段按通知写全（含段内的周末，周末本就空闲，写全便于与通知逐条核对）。
export const DEFAULT_HOLIDAYS: readonly string[] = [
  "2026-01-01", "2026-01-02", "2026-01-03", // 元旦
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23", // 春节
  "2026-04-04", "2026-04-05", "2026-04-06", // 清明
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", // 劳动节
  "2026-06-19", "2026-06-20", "2026-06-21", // 端午
  "2026-09-25", "2026-09-26", "2026-09-27", // 中秋
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07", // 国庆节
];

// 同一通知里的调休上班日（周末上班），按工作日计高峰。
export const DEFAULT_ADDITIONAL_WORKDAYS: readonly string[] = [
  "2026-01-04", // 元旦调休
  "2026-02-14", "2026-02-28", // 春节调休
  "2026-05-09", // 劳动节调休
  "2026-09-20", "2026-10-10", // 国庆节调休
];

// 生效日历：默认取上面的内置表；扩展/代理启动时用 deepseekStatusBar.holidays
// 与 deepseekStatusBar.additionalWorkdays 注入（配置默认值与内置表一致）。
let holidaySet = new Set(DEFAULT_HOLIDAYS);
let extraWorkdaySet = new Set(DEFAULT_ADDITIONAL_WORKDAYS);

const toDaySet = (list?: readonly string[]): Set<string> =>
  new Set(
    (Array.isArray(list) ? list : [])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)),
  );

/**
 * 注入法定节假日与调休上班日（北京日历日 "YYYY-MM-DD"），整表替换。
 * 同一天同时出现在两个列表时按放假处理（不翻倍，稳妥优先）。传 undefined 恢复内置表。
 */
export function setPeakCalendar(
  holidays?: readonly string[],
  additionalWorkdays?: readonly string[],
): void {
  holidaySet =
    holidays === undefined ? new Set(DEFAULT_HOLIDAYS) : toDaySet(holidays);
  extraWorkdaySet =
    additionalWorkdays === undefined
      ? new Set(DEFAULT_ADDITIONAL_WORKDAYS)
      : toDaySet(additionalWorkdays);
}

/** 某 UTC 时刻落在哪个北京日历日（节假日按北京日期整天判定）。 */
function beijingDayStr(t: dayjs.Dayjs): string {
  return t.add(8, "hour").format("YYYY-MM-DD");
}

/** 该时刻所在的北京日历日是否按工作日计高峰：法定节假日与周末不算，调休上班日算。 */
export function isWorkday(
  tsUtc: dayjs.Dayjs | Date | string | number = Date.now(),
): boolean {
  const t = dayjs.utc(tsUtc);
  const day = beijingDayStr(t);
  if (holidaySet.has(day)) return false;
  if (extraWorkdaySet.has(day)) return true;
  const wd = t.add(8, "hour").day(); // 北京日历日的星期（Sun=0..Sat=6）
  return wd !== 0 && wd !== 6;
}

/** 峰谷定价自北京时间 2026-08-17 00:00 起生效（官方更新日志 2026-08-13），此前为单一价。 */
export const PEAK_PRICING_SINCE_MS = Date.parse("2026-08-17T00:00:00+08:00");

/** 某 UTC 时刻是否落在高峰时段（工作日 01:00-04:00、06:00-10:00）。 */
function inPeakWindow(t: dayjs.Dayjs): boolean {
  if (!isWorkday(t)) return false; // 周末/法定节假日全天空闲
  const h = t.hour();
  return PEAK_WINDOWS.some(([from, to]) => h >= from && h < to);
}

/** 某时刻是否按高峰价计费：处于高峰时段，且峰谷定价已生效。 */
export function isPeak(tsUtc: Date | string | number = Date.now()): boolean {
  const t = dayjs.utc(tsUtc);
  if (t.valueOf() < PEAK_PRICING_SINCE_MS) return false;
  return inPeakWindow(t);
}

export interface PeakSegment {
  peak: boolean;
  range: string; // 当前计费段（UTC），如 "01:00-04:00"
}

/** 当前所处计费段（UTC）：高峰=工作日 01:00-04:00、06:00-10:00，其余空闲。 */
export function currentSegment(
  tsUtc: Date | string | number = Date.now(),
): PeakSegment {
  const t = dayjs.utc(tsUtc);
  const h = t.hour();
  if (!isWorkday(t)) return { peak: false, range: "00:00-24:00" };
  if (h < 1) return { peak: false, range: "10:00-01:00" }; // 跨夜空闲，从昨日 10:00 起
  if (h < 4) return { peak: true, range: "01:00-04:00" };
  if (h < 6) return { peak: false, range: "04:00-06:00" };
  if (h < 10) return { peak: true, range: "06:00-10:00" };
  return { peak: false, range: "10:00-01:00" };
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
