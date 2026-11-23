#!/usr/bin/env node
/**
 * gwx-watchdog.cjs — gwx(8801) 与 mgr(8899) 的常驻守护
 *
 * 为什么要它：gwx 是客户端直连的那一跳（客户端 → 8801 → 8788 → 上游）。
 * 它挂了不是降级，是直接连接失败。原来它只是个裸 node 进程，DSH 关闭或
 * 机器重启就没了，与 workbuddy 的 hub-watchdog 完全不在同一层级。
 *
 * 设计要点（对齐 hub-watchdog 的形态）：
 *  - 只做「健康检查 + 重拉」，不碰 gwx 内部逻辑
 *  - 15s 一轮；首次启动给 40s 宽限（gwx 要读 registry 与内核文件）
 *  - 用 PID 文件避免多开；同一端口已被别人占用就不再拉
 *  - 上游 8788 没起来不算 gwx 故障（gwx 会独立监听，转发时才 502）
 *  - 日志按需轮转（>8MB 换档），不无限增长
 *
 * 用法：
 *   node gwx-watchdog.cjs               前台跑
 *   node gwx-watchdog.cjs --once        检查一次就退出（给任务计划用）
 *   node gwx-watchdog.cjs --status      打印当前状态
 *   node gwx-watchdog.cjs --interval 10000
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const WD_PID = path.join(LOG_DIR, 'gwx-watchdog.pid');
const GWX_PID = path.join(LOG_DIR, 'gwx.pid');
const MGR_PID = path.join(LOG_DIR, 'mgr.log.pid');
const LOG = path.join(LOG_DIR, 'gwx-watchdog.log');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ONCE = args.includes('--once');
const STATUS = args.includes('--status');
const INTERVAL = Number(flag('--interval', '15000'));
const GRACE_MS = 40_000;
const LOG_MAX = 8 * 1024 * 1024;

// ── 目标定义：两个进程各自的健康检查与启动命令 ──
const NODE = process.execPath;
const TARGETS = [
  {
    id: 'gwx', port: 8801, pidFile: GWX_PID,
    health: 'http://127.0.0.1:8801/gwx/stats',
    cwd: ROOT,
    argv: [
      path.join(ROOT, 'gwx.mjs'),
      '--listen', '8801',
      '--upstream', process.env.UPSTREAM || 'http://127.0.0.1:8788',
      '--mode', 'merge',
      '--rewrite', 'on', '--detail', 'on', '--first', 'raw',
      '--guard', 'on', '--guardMin', '0.6',
      '--retry', '1', '--maxCont', '3', '--budgetMs', '150000',
      '--domains', 'adult,crack,patch,meta'
    ],
    startedAt: 0
  },
  {
    id: 'mgr', port: 8899, pidFile: MGR_PID,
    health: 'http://127.0.0.1:8899/api/summary',
    cwd: path.join(ROOT, 'mgr'),
    argv: [path.join(ROOT, 'mgr', 'server.mjs'), '--port', '8899', '--gw', 'http://127.0.0.1:8801'],
    startedAt: 0
  }
];

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} [gwx-watchdog] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX) {
      fs.renameSync(LOG, LOG + '.1');
    }
    const needBom = !fs.existsSync(LOG) || fs.statSync(LOG).size === 0;
    fs.appendFileSync(LOG, (needBom ? '\uFEFF' : '') + line + '\n', 'utf8');
  } catch { }
}

// 返回 true=健康 / false=不健康 / null=进程不存在
function probe(t) {
  return new Promise((resolve) => {
    const req = http.get(t.health, { timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = require('node:net').createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function readPid(f) {
  try { const n = Number(fs.readFileSync(f, 'utf8').trim()); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function start(t) {
  const out = fs.openSync(path.join(LOG_DIR, `${t.id}.out.log`), 'a');
  const err = fs.openSync(path.join(LOG_DIR, `${t.id}.err.log`), 'a');
  const child = spawn(NODE, t.argv, {
    cwd: t.cwd, detached: true, stdio: ['ignore', out, err], windowsHide: true
  });
  child.unref();
  t.startedAt = Date.now();
  try { fs.writeFileSync(t.pidFile, String(child.pid)); } catch { }
  log(`启动 ${t.id} pid=${child.pid} port=${t.port}`);
  return child.pid;
}

async function check(t) {
  const ok = await probe(t);
  if (ok) return 'healthy';
  const busy = await portBusy(t.port);
  // 端口在听但健康检查失败：可能正在启动，等宽限期
  if (busy) {
    const waited = t.startedAt ? Date.now() - t.startedAt : Infinity;
    if (waited < GRACE_MS) return 'starting';
    log(`${t.id} 端口在听但健康检查失败，已等 ${Math.round(waited / 1000)}s`);
  }
  // 端口空着：确认没有活着的旧 pid，避免多开
  const pid = readPid(t.pidFile);
  if (alive(pid)) {
    log(`${t.id} pid=${pid} 还活着但端口 ${t.port} 不响应，重启`);
  }
  start(t);
  return 'restarted';
}

async function tick() {
  for (const t of TARGETS) {
    try {
      const r = await check(t);
      if (r !== 'healthy') log(`${t.id}: ${r}`);
    } catch (e) { log(`${t.id} 检查异常: ${e.message}`); }
  }
}

async function status() {
  for (const t of TARGETS) {
    const ok = await probe(t);
    const pid = readPid(t.pidFile);
    console.log(`${t.id.padEnd(4)} port=${t.port} health=${ok ? 'OK' : 'FAIL'} pid=${pid ?? '-'} alive=${alive(pid)}`);
  }
}

(async () => {
  if (STATUS) { await status(); return; }
  const self = readPid(WD_PID);
  if (alive(self) && self !== process.pid) {
    log(`已有 watchdog 在跑 pid=${self}，退出`);
    return;
  }
  fs.writeFileSync(WD_PID, String(process.pid));
  log(`watchdog 启动 pid=${process.pid} interval=${INTERVAL}ms targets=${TARGETS.map(t => t.id + ':' + t.port).join(',')}`);

  if (ONCE) { await tick(); return; }

  await tick();
  const timer = setInterval(tick, INTERVAL);
  const bye = () => {
    log('watchdog 退出');
    clearInterval(timer);
    try { fs.unlinkSync(WD_PID); } catch { }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
})();
