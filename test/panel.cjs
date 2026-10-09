const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const source = fs.readFileSync('src/detailPanel.ts', 'utf8') + '\nexport { render }; export { aggregateWindow } from "./stats";';
const code = esbuild.buildSync({ stdin: { contents: source, resolveDir: path.resolve('src'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text;
const extensionModule = { exports: {} };
vm.runInNewContext(code, { module: extensionModule, exports: extensionModule.exports, require: name => name === 'vscode' ? {
  env: { language: 'en' }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
} : require(name), console });
const { render, aggregateWindow } = extensionModule.exports;
const start = Date.parse('2026-09-10T00:00:00+08:00');
const end = start + 86400000;
const html = render({ ...aggregateWindow([], start, end, 3600000), peakNow: false, balance: null, balanceHistory: [], win: { start, end }, chartWin: { start, end }, extent: { start, end } }, 'all', 'cost', { date: '2026-09-10', mode: 'day', bucketMs: 3600000 }, false, false, { chart: 'chart.js', init: 'init.js', css: 'style.css' });
assert.ok(!html.includes('id="date"'));
const elements = {};
for (const match of html.matchAll(/<(?:input|select|button|div)[^>]*\bid="([^"]+)"[^>]*>/g)) {
  const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  elements[match[1]] = { ...attrs, style: {}, handlers: {}, value: attrs.value || '0',
    addEventListener(name, fn) { this.handlers[name] = fn; },
    setAttribute(name, value) { this[name] = value; },
    setCustomValidity(value) { this.invalid = value; },
    reportValidity() { return !this.invalid; },
  };
}
const messages = [];
let refresh;
const document = { activeElement: null, body: { dataset: { range: 'all' } }, getElementById: id => elements[id] || null, querySelectorAll: () => [] };
vm.runInNewContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1], {
  document, acquireVsCodeApi: () => ({ postMessage: msg => messages.push(msg) }), setInterval: fn => { refresh = fn; },
});
const lo = elements.rangeStart, hi = elements.rangeEnd;
lo.value = String(start + 3600000); lo.handlers.input(); lo.handlers.change();
assert.equal(messages.at(-1).start, start + 3600000);
assert.equal(messages.at(-1).end, end);
assert.ok(Math.abs(parseFloat(elements.rangeFill.style.left) - 100 / 24) < 1e-10);
lo.value = hi.value; lo.handlers.input();
assert.equal(+hi.value - +lo.value, 60000);
elements.windowEnd.value = elements.windowStart.value;
const count = messages.length;
elements.windowEnd.handlers.change();
assert.equal(messages.length, count);
elements.grain.value = '300000'; elements.grain.handlers.change();
assert.equal(messages.at(-1).grain, 300000);
elements.export.handlers.click(); assert.equal(messages.at(-1).type, 'exportCsv');
document.activeElement = { tagName: 'INPUT' }; refresh(); assert.equal(messages.at(-1).type, 'exportCsv');
document.activeElement = null; refresh(); assert.equal(messages.at(-1).type, 'refresh');
console.log('Panel PASS: All view handlers, slider bounds, UTC timestamps, invalid interval, grain, export, editing refresh');
