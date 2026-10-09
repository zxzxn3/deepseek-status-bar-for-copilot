// 单元测试：定价、区间窗口、聚合、图表数据、货币、JSONL、i18n。
// 运行：npm test
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ADDITIONAL_WORKDAYS,
  DEFAULT_HOLIDAYS,
  isPeak,
  isWorkday,
  currentSegment,
  costFromUsage,
  modelPrice,
  setPeakCalendar,
  setPriceOverrides,
  effectiveTable,
  SCHEDULE,
} from "./src/pricing";
import {
  utcDayStartMs,
  rangeWindow,
  allChartWindow,
  customRangeWindow,
  aggregateRange,
  aggregateCustom,
  aggregateWindow,
} from "./src/stats";
import { buildChartPayload, ChartKind } from "./src/chartData";
import { fmtMoney, moneyPair } from "./src/currency";
import { appendRecord, TailReader, UsageRecord } from "./src/jsonl";
import { t, isZh } from "./src/i18n";

let failures = 0;
const check = (name: string, got: unknown, exp: unknown) => {
  const ok = String(got) === String(exp);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name} → ${String(got)} ${ok ? "" : `(期望 ${String(exp)})`}`);
};

// 北京时间（UTC+8）日历时刻 → UTC ISO 字符串
const BEO = 8 * 3600 * 1000;
const bjIso = (y: number, m: number, d: number, h: number, min = 0): string =>
  new Date(Date.UTC(y, m - 1, d, h, min) - BEO).toISOString();
// UTC 日历时刻 → ISO 字符串
const utcIso = (y: number, m: number, d: number, h: number, min = 0): string =>
  new Date(Date.UTC(y, m - 1, d, h, min)).toISOString();

// ---------- 1. 定价 ----------
{
  check("peak 周二 02:00Z", isPeak(utcIso(2026, 8, 25, 2)), true);
  check("peak 周二 01:00Z 边界", isPeak(utcIso(2026, 8, 25, 1)), true);
  check("peak 周二 04:00Z 非峰", isPeak(utcIso(2026, 8, 25, 4)), false);
  check("peak 周二 06:00Z 边界", isPeak(utcIso(2026, 8, 25, 6)), true);
  check("peak 周二 10:00Z 非峰", isPeak(utcIso(2026, 8, 25, 10)), false);
  check("peak 周六非峰", isPeak(utcIso(2026, 8, 29, 2)), false);
  check("peak 周日非峰", isPeak(utcIso(2026, 8, 23, 2)), false);
  // 峰谷定价 2026-08-17 00:00（北京）生效：周五 02:00Z 仍是单一价，周一同时刻起翻倍
  check("峰谷生效前非峰", isPeak(utcIso(2026, 8, 14, 2)), false);
  check("峰谷生效当刻", isPeak(utcIso(2026, 8, 17, 2)), true);

  check("seg 02:00Z", currentSegment(utcIso(2026, 8, 25, 2)).range, "01:00-04:00");
  check("seg 05:00Z", currentSegment(utcIso(2026, 8, 25, 5)).range, "04:00-06:00");
  check("seg 08:00Z", currentSegment(utcIso(2026, 8, 25, 8)).range, "06:00-10:00");
  check("seg 13:00Z", currentSegment(utcIso(2026, 8, 25, 13)).range, "10:00-01:00");
  check("seg 00:30Z 跨夜", currentSegment(utcIso(2026, 8, 26, 0)).range, "10:00-01:00");
  check("seg 周六", currentSegment(utcIso(2026, 8, 29, 2)).range, "00:00-24:00");
  check("seg 02:00Z 计峰", currentSegment(utcIso(2026, 8, 25, 2)).peak, true);

  // 法定节假日整天不计高峰：2026-09-25(周五)/09-27(周日) 中秋，10-01(周四) 国庆
  check("节假日周五 02:00Z", isPeak(utcIso(2026, 9, 25, 2)), false);
  check("节假日周日 02:00Z", isPeak(utcIso(2026, 9, 27, 2)), false);
  check("节假日周四 02:00Z", isPeak(utcIso(2026, 10, 1, 2)), false);
  check("节假日前一天周四", isPeak(utcIso(2026, 9, 24, 2)), true);
  check("节假日后一天周四", isPeak(utcIso(2026, 10, 8, 2)), true);
  check("节假日段", currentSegment(utcIso(2026, 10, 1, 2)).range, "00:00-24:00");
  check("节假日不加班", isWorkday(utcIso(2026, 10, 1, 2)), false);
  // 调休上班日：2026-09-20(周日)、10-10(周六) 按工作日计高峰
  check("调休周日计峰", isPeak(utcIso(2026, 9, 20, 2)), true);
  check("调休周六计峰", isPeak(utcIso(2026, 10, 10, 2)), true);
  check("调休周日上班", isWorkday(utcIso(2026, 9, 20, 2)), true);
  check("普通周六不上班", isWorkday(utcIso(2026, 8, 29, 2)), false);
  check("调休日段", currentSegment(utcIso(2026, 10, 10, 2)).range, "01:00-04:00");
  // 注入覆盖：整表替换，同一天既放假又上班时按放假
  setPeakCalendar(["2026-08-25"], ["2026-08-25", "2026-08-29"]);
  check("自定义放假日", isPeak(utcIso(2026, 8, 25, 2)), false);
  check("放假优先于上班", isWorkday(utcIso(2026, 8, 25, 2)), false);
  check("自定义上班日", isPeak(utcIso(2026, 8, 29, 2)), true);
  check("未列出的工作日", isPeak(utcIso(2026, 8, 26, 2)), true);
  setPeakCalendar([]);
  check("清空后周末整天空闲", isPeak(utcIso(2026, 8, 29, 2)), false);
  check("清空后节假日照常计峰", isPeak(utcIso(2026, 10, 1, 2)), true);
  setPeakCalendar();
  check("恢复内置日历", isPeak(utcIso(2026, 10, 1, 2)), false);
  check("非法日期被忽略", (() => { setPeakCalendar(["nope", "2026-10-01"]); const r = isPeak(utcIso(2026, 10, 1, 2)); setPeakCalendar(); return r; })(), false);

  const T = Date.parse("2026-09-12T00:00:00+08:00");
  const old = Date.parse("2026-09-09T00:00:00+08:00");
  const flash = Date.parse("2026-09-10T12:00:00+08:00");
  const pro = Date.parse("2026-09-14T12:00:00+08:00");
  check("cost flash 非峰", costFromUsage(2e6, 1e6, 1e6, 1e6, "deepseek-v4-flash", false, T), 5.02);
  check("cost flash 峰 ×2", costFromUsage(2e6, 1e6, 1e6, 1e6, "deepseek-v4-flash", true, T), 10.04);
  check("cost flash 历史", costFromUsage(2e6, 1e6, 1e6, 1e6, "deepseek-v4-flash", false, old), 6.05);
  check("cost pro 非峰", costFromUsage(1e6, 1e6, 0, 1e6, "deepseek-v4-pro", false, T), 18);
  check("未知模型回退", modelPrice("nope", T).cache_hit, 0.02);
  check("历史新模型回退", modelPrice("deepseek-flash", old).cache_miss, 1.5);
  check("历史未知回退", modelPrice("nope", old).cache_miss, 1.5);
  check("Flash 边界前 1ms", modelPrice("deepseek-v4-flash", flash - 1).cache_miss, 1.5);
  check("Pro 边界前 1ms", modelPrice("deepseek-v4-pro", pro - 1).cache_miss, 4.5);
  // 官方更新日志 2026-09-10：9/14 之后继续提供 V4 Pro，计费方式不变 → 不并入 Flash 价
  check("Pro 边界当刻仍按 Pro 价", modelPrice("deepseek-v4-pro", pro).cache_miss, 4.5);
  check("Pro 之后仍按 Pro 价", modelPrice("deepseek-v4-pro", Date.parse("2026-10-01T00:00:00Z")).output, 13.5);
  check("Pro 之后缓存命中价", modelPrice("deepseek-v4-pro", Date.parse("2026-10-01T00:00:00Z")).cache_hit, 0.15);
  for (const m of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    check(`${m} 新档`, JSON.stringify(modelPrice(m, flash)), JSON.stringify({ cache_hit: 0.02, cache_miss: 1, output: 4 }));
  }
  check("档位严格升序", SCHEDULE.every((t, i) => i === 0 || t.fromUtcMs > SCHEDULE[i - 1].fromUtcMs), true);
  check("各档保留旧 Flash", SCHEDULE.every(t => !!effectiveTable(t.fromUtcMs)["deepseek-v4-flash"]), true);
  setPriceOverrides({ "deepseek-flash": { output: 9 }, "custom": { cache_hit: 0 } });
  for (const ts of [old, T, pro]) {
    check("覆盖适用所有时间", modelPrice("deepseek-flash", ts).output, 9);
    check("自定义模型零价", modelPrice("custom", ts).cache_hit, 0);
  }
  check("覆盖未指定字段沿用历史", modelPrice("deepseek-flash", old).cache_miss, 1.5);
  check("覆盖未指定字段沿用新价", modelPrice("deepseek-flash", T).cache_miss, 1);
  check("覆盖不影响 Pro", modelPrice("deepseek-v4-pro", T).cache_hit, 0.15);
  setPriceOverrides();
  check("清除覆盖", modelPrice("deepseek-flash", T).output, 4);
  const copy = effectiveTable(T);
  copy["deepseek-flash"].output = 100;
  check("返回表隔离", modelPrice("deepseek-flash", T).output, 4);
}

// ---------- 1b. 节假日默认值一致性 ----------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const props = pkg.contributes.configuration.properties;
  check(
    "package.json holidays 默认值 = 内置表",
    JSON.stringify(props["deepseekStatusBar.holidays"].default),
    JSON.stringify(DEFAULT_HOLIDAYS),
  );
  check(
    "package.json additionalWorkdays 默认值 = 内置表",
    JSON.stringify(props["deepseekStatusBar.additionalWorkdays"].default),
    JSON.stringify(DEFAULT_ADDITIONAL_WORKDAYS),
  );
  // 2026 年国办通知：放假 33 天、调休上班 6 天
  check("节假日天数", DEFAULT_HOLIDAYS.length, 33);
  check("调休上班天数", DEFAULT_ADDITIONAL_WORKDAYS.length, 6);
  check("日期格式", DEFAULT_HOLIDAYS.concat(DEFAULT_ADDITIONAL_WORKDAYS).every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), true);
}

// ---------- 2. 区间窗口 ----------
{
  const now = new Date(utcIso(2026, 8, 27, 12)); // 周四 12:00 UTC
  const DAY = 86400000;
  const tw = rangeWindow("today", now);
  check("today start UTC 零点", tw.start, Date.parse("2026-08-27T00:00:00.000Z"));
  check("today end", tw.end - tw.start, DAY);
  const ww = rangeWindow("week", now);
  check("week start 周一", ww.start, Date.parse("2026-08-24T00:00:00.000Z"));
  check("week span 7天", ww.end - ww.start, 7 * DAY);
  const mw = rangeWindow("month", now);
  check("month start 8/1", mw.start, Date.parse("2026-08-01T00:00:00.000Z"));
  check("month end 9/1", mw.end, Date.parse("2026-09-01T00:00:00.000Z"));
  check("utcDayStart", utcDayStartMs(now), tw.start);
  const cw = customRangeWindow("2026-08-27", "week");
  check("custom week start", cw.start, ww.start);
  const cm = customRangeWindow("2026-08-27", "month");
  check("custom month start", cm.start, mw.start);
  const cd = customRangeWindow("2026-08-27", "day");
  check("custom day span", cd.end - cd.start, DAY);
  // allChartWindow：最早记录 UTC 日 → 今天 UTC 日结束
  const earliest = { ts: utcIso(2026, 8, 19, 21), model: "m", prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cache_hit_tokens: 0, cache_miss_tokens: 0, stream: true, status: 200 };
  const aw = allChartWindow([earliest], now);
  check("allChart start 最早 UTC 日", aw.start, Date.parse("2026-08-19T00:00:00.000Z"));
  check("allChart end 今天末", aw.end, tw.end);
}

// ---------- 3. 聚合 ----------
{
  const now = new Date(bjIso(2026, 8, 27, 12));
  const rec = (ts: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
    ts, model: "deepseek-v4-flash", prompt_tokens: 1e6, completion_tokens: 0,
    total_tokens: 1e6, cache_hit_tokens: 0, cache_miss_tokens: 1e6,
    stream: true, status: 200, ...extra,
  });
  const r1 = rec(bjIso(2026, 8, 27, 10), { ms: 1000 }); // 峰
  const r2 = rec(bjIso(2026, 8, 27, 21), { ms: 2000 }); // 非峰
  const rY = rec(bjIso(2026, 8, 26, 10)); // 昨天，应排除
  const r402 = rec(bjIso(2026, 8, 27, 11), { status: 402, prompt_tokens: 0, cache_miss_tokens: 0, total_tokens: 0, completion_tokens: 0 });
  const s = aggregateRange([r1, r2, rY, r402], "today", now);
  check("today count", s.count, 3);
  check("today count402", s.count402, 1);
  check("today prompt", s.p, 2e6);
  // r1 峰:1.5×2=3.0, r2 非峰:1.5, r402:0 → 4.5
  check("today cost", s.cost.toFixed(4), "4.5000");
  check("today chCost=0", s.chCost, 0);
  check("avgMs (无ms的402不计)", s.avgMs, 1500);
  check("maxMs", s.maxMs, 2000);
  check("buckets 数", s.buckets.length, 3); // 10/11/21 时
  check("recent[0] 最新 21:00", s.recent[0].ts, r2.ts);
  check("models 数", s.models.length, 1);
  check("model count", s.models[0].m.count, 3);
  check("model avgMs", s.models[0].m.avgMs, 1500);

  // 跨调价边界：旧价高峰 + 新价空闲，同时验证缓存费用分项。
  const boundary = Date.parse("2026-09-10T12:00:00+08:00");
  const mixed = aggregateRange([
    rec(new Date(boundary - 1).toISOString(), { cache_hit_tokens: 1e6, prompt_tokens: 2e6 }),
    rec(new Date(boundary).toISOString(), { cache_hit_tokens: 1e6, prompt_tokens: 2e6 }),
  ], "today", new Date(boundary));
  check("跨档聚合费用", mixed.cost.toFixed(4), "4.1200");
  check("跨档缓存费用", mixed.chCost.toFixed(4), "0.1200");

  // 自定义周：rY（8/26 周三）与 r1/r2 同周 → 3 条
  const sw = aggregateCustom([r1, r2, rY], "2026-08-27", "week", );
  check("custom week count", sw.count, 3);
  const sm = aggregateCustom([r1, r2, rY], "2026-08-27", "month");
  check("custom month count", sm.count, 3);
  // 桶对齐 UTC 日：r1 落在 08-27 第 02 时
  const HOUR = 3600000;
  const dayStart = Date.parse("2026-08-27T00:00:00.000Z");
  check("bucket r1 对齐 02 时", s.buckets.some((b) => b.start === dayStart + 2 * HOUR), true);
}

// ---------- 4. 图表数据 ----------
{
  const HOUR = 3600000;
  const utcDayStart = Date.parse("2026-08-27T00:00:00.000Z"); // 08-27 00:00 UTC
  const mk = (start: number, over: Partial<Parameters<typeof buildChartPayload>[0][number]> = {}) => ({
    label: "x", start, cost: 0, tokens: 0, costCacheHit: 0, costCacheMiss: 0, costOutput: 0,
    tokCacheHit: 0, tokCacheMiss: 0, tokOutput: 0, avgMs: 0, ...over,
  });
  const buckets = [
    mk(utcDayStart + 10 * HOUR, { costCacheHit: 100, costCacheMiss: 50, costOutput: 200, avgMs: 1500 }),
  ];
  const chartWin = { start: utcDayStart, end: utcDayStart + 24 * HOUR };
  const p = buildChartPayload(buckets, "cost" as ChartKind, true, true, chartWin, [], false, true)!;
  check("labels 24 槽", p.labels.length, 24);
  check("label[10]=10", p.labels[10], "10");
  check("hit[10]", p.hit[10], 100);
  check("miss[10]", p.miss[10], 50);
  check("out[10]", p.out[10], 200);
  check("hit[0]=0", p.hit[0], 0);
  check("latency[10]", p.latency[10], 1500);
  check("latency[0]=null", p.latency[0], null);
  check("latencyOn", p.latencyOn, true);
  // tokens 模式
  const p2 = buildChartPayload(buckets, "tokens" as ChartKind, true, true, chartWin, [], false, false)!;
  check("tokens hit[10]=0（桶无 tok 值）", p2.hit[10], 0);
  check("latencyOn 关", p2.latencyOn, false);
  // 余额按小时平均
  const bal = [{ ts: utcDayStart + 10 * HOUR + HOUR / 2, cny: 10 }];
  const p3 = buildChartPayload(buckets, "cost" as ChartKind, true, true, chartWin, bal, true, false)!;
  check("balance[10]", p3.balance![10], 10);
  check("balance[0]=null", p3.balance![0], null);
  check("useTimeAxis 小时视图 false", p3.useTimeAxis, false);
  // 月视图：天柱 + 日号标签 + 独立时间轴
  const p4 = buildChartPayload(buckets, "cost" as ChartKind, false, false, chartWin, bal, true, false)!;
  check("month label[0]=日号27", p4.labels[0], "27");
  check("month useTimeAxis true", p4.useTimeAxis, true);
  check("month balance 是点数组", Array.isArray(p4.balance) && typeof p4.balance![0] === "object", true);
}

// ---------- 5. 货币 ----------
{
  check("cny 4位", fmtMoney(1.23456789, "cny", 6.74), "￥1.2346");
  check("usd 转换", fmtMoney(6.74, "usd", 6.74), "$1.0000");
  check("digits=2", fmtMoney(9.5, "cny", 6.74, 2), "￥9.50");
  check("moneyPair", moneyPair(1, 0.5, "cny", 6.74), "￥1.0000/￥0.5000");
  check("负数", fmtMoney(-1.5, "cny", 6.74, 2), "￥-1.50");
}

// ---------- 6. JSONL TailReader ----------
{
  const file = path.join(os.tmpdir(), `dsu-test-${Date.now()}.jsonl`);
  fs.rmSync(file, { force: true });
  const rec = { ts: bjIso(2026, 8, 27, 10), model: "m", prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cache_hit_tokens: 0, cache_miss_tokens: 0, stream: true, status: 200 };
  appendRecord(file, rec);
  const reader = new TailReader(file);
  check("首读 1 条", reader.readNew().length, 1);
  // 追加无效 JSON（无换行）→ 不应被消费
  fs.appendFileSync(file, "not-json{");
  check("半行不消费", reader.readNew().length, 0);
  // 补全换行 + 完整行
  fs.appendFileSync(file, '\n{"ts":"full","model":"m","prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cache_hit_tokens":0,"cache_miss_tokens":0,"stream":true,"status":200}\n');
  const got = reader.readNew();
  check("补全后读到完整行", got.length, 1);
  check("损坏行被跳过", got[0].ts, "full");
  // reset 重扫
  reader.reset();
  check("reset 重扫全部", reader.readNew().length, 2);
  fs.rmSync(file, { force: true });
}

// ---------- 7. i18n ----------
{
  check("zh 界面", isZh(), true);
  check("t 中文", t("cost"), "费用");
  check("t 占位替换", t("err402", { n: 3 }), "3 次 HTTP 402 —— 检测到余额不足");
  check("t 缺键返回 key", t("not_exist_key"), "not_exist_key");
}

// Arbitrary boundaries: include start, exclude end, retain partial final bucket.
{
  const start = Date.parse("2026-09-10T23:57:00+08:00");
  const minute = 60000;
  const rec = (offset: number, ms: number): UsageRecord => ({
    ts: new Date(start + offset * minute).toISOString(), model: "deepseek-v4-flash",
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    cache_hit_tokens: 0, cache_miss_tokens: 10, stream: false, status: 200, ms,
  });
  const data = aggregateWindow([rec(-1, 10), rec(0, 100), rec(4, 300), rec(5, 200), rec(10, 50), rec(11, 99)], start, start + 11 * minute, 5 * minute);
  check("window count", data.count, 4);
  check("window weighted latency", data.avgMs, 163);
  check("window bucket count", data.buckets.length, 3);
  check("window first latency", data.buckets[0].avgMs, 200);
  const chart = buildChartPayload(data.buckets, "tokens", true, true,
    { start, end: start + 11 * minute }, [], false, true, 5 * minute)!;
  check("window chart preserves tokens", chart.miss.reduce((a, b) => a + b, 0), 40);
  check("window chart partial bucket", chart.out[2], 5);
  check("window label 按 UTC", chart.labels[1], "09-10 16:02");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
