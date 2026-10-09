// Real loopback servers, isolated extension modules representing separate windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-lifecycle-'));
const jsonl = path.join(dir, 'usage.jsonl');
const source = fs.readFileSync('src/extension.ts', 'utf8') + `
export { startProxy, stopProxy };
export function setup(file: string) { jsonlPath = file; balancePath = file + '.balance'; }
export function running() { return activePort !== null; }
`;
const code = esbuild.buildSync({ stdin: { contents: source, resolveDir: path.resolve('src'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text;
let baseUrl;
let port;
let spawnCount = 0;
let child;
let ownedServer;
const log = { append() {}, appendLine() {} };
const vscode = {
  env: { language: 'en' }, ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration: section => ({
    get: (key, fallback) => section === 'deepseekStatusBar' && key === 'port' ? port : fallback,
    inspect: () => ({ globalValue: baseUrl }),
    update: async (_key, value) => { baseUrl = value; },
  }) },
  commands: { executeCommand() {} },
  window: { createOutputChannel: () => log, showWarningMessage() {} },
};
function server(identity = true) {
  return http.createServer((_req, res) => {
    res.end(JSON.stringify(identity ? { service: 'deepseek-status-bar', jsonlPath: jsonl } : { other: true }));
  });
}
function windowModule() {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name === 'vscode' ? vscode : name === 'child_process' ? {
      spawn() {
        spawnCount++;
        child = new EventEmitter();
        ownedServer = server();
        ownedServer.listen(port, '127.0.0.1');
        child.kill = () => { child.killed = true; ownedServer.close(); child.emit('exit', 0); };
        return child;
      },
    } : require(name),
  });
  module.exports.setup(jsonl);
  return module.exports;
}
const context = { extensionUri: { fsPath: process.cwd() } };
const listen = srv => new Promise(resolve => srv.listen(0, '127.0.0.1', () => { port = srv.address().port; resolve(); }));
const close = srv => new Promise(resolve => srv.close(resolve));
async function main() {
  // Two windows reuse a service, then its owner disappears.
  let srv = server(); await listen(srv);
  baseUrl = 'https://original.example/v1';
  const a = windowModule(), b = windowModule();
  await a.startProxy(context); await b.startProxy(context);
  assert.equal(a.running(), true); assert.equal(b.running(), true);
  assert.equal(spawnCount, 0);
  await close(srv);
  await new Promise(resolve => setTimeout(resolve, 2400));
  assert.equal(a.running(), false); assert.equal(b.running(), false);
  assert.equal(baseUrl, 'https://original.example/v1');
  // Closing a borrower must leave the owner's URL alone.
  srv = server(); await listen(srv);
  await a.startProxy(context); await b.startProxy(context);
  await b.deactivate();
  assert.equal(baseUrl, `http://127.0.0.1:${port}`);
  await a.stopProxy(); await close(srv);
  assert.equal(baseUrl, 'https://original.example/v1');
  // An unrelated listener cannot capture the API URL.
  srv = server(false); await listen(srv);
  await a.startProxy(context);
  assert.equal(a.running(), false); assert.equal(baseUrl, 'https://original.example/v1');
  await close(srv);
  // Spawned process death immediately restores an absent global override.
  baseUrl = undefined;
  await Promise.all([a.startProxy(context), a.startProxy(context)]);
  assert.equal(a.running(), true); assert.equal(spawnCount, 1);
  child.kill();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(baseUrl, undefined); assert.equal(a.running(), false);
  // An address left by an older version has no original backup: remove its override.
  fs.unlinkSync(path.join(dir, 'base-url-backup.json'));
  baseUrl = `http://127.0.0.1:${port}`;
  await a.startProxy(context); await a.stopProxy();
  assert.equal(baseUrl, undefined);
  // Manual edits are preserved on stop.
  await a.startProxy(context);
  baseUrl = 'https://manual.example/v1';
  await a.stopProxy();
  assert.equal(baseUrl, 'https://manual.example/v1');
  await b.stopProxy();
  console.log('Proxy lifecycle PASS: shared loss, unrelated port, child exit, undefined original, manual edit');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  ownedServer?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
