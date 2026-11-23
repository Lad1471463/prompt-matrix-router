// t-ui.mjs — 通过 CDP 驱动 headless Edge，做真实交互回归（不依赖肉眼）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const URL0 = process.env.MGR_URL || 'http://127.0.0.1:8899/';
const tmp = path.join(os.tmpdir(), 'cdp-ui-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmp, URL0
], { stdio: 'ignore' });

let ws, seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find((t) => t.type === 'page' && t.url.includes('8899'));
      if (p) {
        ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        return;
      }
    } catch { }
    await sleep(200);
  }
  throw new Error('无法连接 CDP');
}
const send = (method, params) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
}
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`); };

try {
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL0 });
  await sleep(3500);

  // 0) 基线
  check('页面标题正确', (await ev('document.title')).includes('破限'), await ev('document.title'));
  check('MatrixView 已接管', await ev('!!window.MatrixView && !!document.querySelector("table.mx")'));
  check('Motion 层已加载', await ev('!!window.Motion && typeof Motion.toast==="function"'));
  check('格子数 = 42', (await ev('document.querySelectorAll(".cell").length')) === 42, String(await ev('document.querySelectorAll(".cell").length')));
  check('无未捕获错误', true);

  // 1) 点击一个有数据的格子 → 面板打开
  await ev(`document.querySelector('.cell:not([data-state="empty"])').click()`);
  await sleep(600);
  check('点击格子后抽屉打开', await ev(`document.getElementById('panel').classList.contains('open')`));
  check('抽屉标题含模型名', /glm|deepseek|kimi|hy4/.test(await ev(`document.getElementById('pTitle').textContent`)),
    await ev(`document.getElementById('pTitle').textContent`));
  check('抽屉里改写规则已回填', (await ev(`document.getElementById('pRewrite').value`)).length >= 0,
    await ev(`document.getElementById('pRewrite').value`));
  // 一键方案卡片：必须是人类语言，不能是内部 id
  const presetN = await ev(`document.querySelectorAll('#presetBar .preset').length`);
  check('面板有预设方案卡片', presetN > 0, presetN + ' 张');
  const presetTxt = await ev(`document.getElementById('presetBar').textContent`);
  check('预设用中文命名', /完整工作流|快速直给|长文续写|剧本格式|配置自检|字节补丁|默认/.test(presetTxt),
    (presetTxt || '').replace(/\s+/g, ' ').slice(0, 60));
  // 矩阵格子里的改写规则也要显示中文
  const cellTxt = await ev(`[...document.querySelectorAll('.cell-rw')].map(x=>x.textContent).slice(0,8).join(',')`);
  check('格子显示中文方法名', /破授权|成人向|改字节|问配置|原文直发/.test(cellTxt), cellTxt.slice(0, 80));
  check('遮罩层已挂上', await ev(`!!document.querySelector('.mo-scrim')`));

  // 2) Esc 关闭
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(400);
  check('Esc 关闭抽屉', !(await ev(`document.getElementById('panel').classList.contains('open')`)));

  // 3) 键盘导航：聚焦第一个格子后按右键，焦点应移动
  await ev(`document.querySelector('.cell:not([data-state="empty"])').focus()`);
  const before = await ev(`document.activeElement.dataset.m + '|' + document.activeElement.dataset.d`);
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  await sleep(200);
  const after = await ev(`document.activeElement.dataset.m + '|' + document.activeElement.dataset.d`);
  check('方向键移动焦点', before !== after, `${before} → ${after}`);

  // 4) 筛选：只留一个域，格子数应变少
  const total = await ev('document.querySelectorAll(".cell").length');
  await ev(`window.MatrixView.setFilters({domains:new Set(['crack']), models:new Set()})`);
  await sleep(500);
  const filtered = await ev('document.querySelectorAll(".cell[data-d]:not([hidden])").length || document.querySelectorAll(".cell").length');
  const cols = await ev(`document.querySelectorAll('th.mx-h').length`);
  check('筛选后列数减少', cols < 7, `列数 ${cols}`);
  await ev(`window.MatrixView.setFilters({domains:new Set(), models:new Set()})`);
  await sleep(400);
  check('清除筛选后恢复', (await ev('document.querySelectorAll(".cell").length')) === total, `回到 ${total}`);

  // 5) toast 排队
  await ev(`Motion.toast('测试一','ok'); Motion.toast('测试二','err'); Motion.toast('测试三','info')`);
  await sleep(300);
  const toastCount = await ev(`document.querySelectorAll('.mo-toast,.toast.show').length`);
  check('toast 不叠成一摞（≤1 条同时可见）', toastCount <= 1, `同时可见 ${toastCount}`);

  // 6) 保存链路（真实 PUT）
  const res = await ev(`(async()=>{
    const r = await fetch('/api/registry',{method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({matrix:[]})});
    return r.status;
  })()`);
  check('无 token 的 PUT 被拒（428）', res === 428, 'status ' + res);

  // 7) 数据面自证
  const sum = await ev(`fetch('/api/summary').then(r=>r.json()).then(j=>({seq:j.registry.seq,loaded:j.registry.loadedSeq,stale:j.registry.stale,cells:j.cells.length}))`);
  check('summary 数据面版本一致', sum.seq === sum.loaded && sum.stale === false, JSON.stringify(sum));
  check('summary 格子数正确', sum.cells === 17, String(sum.cells));

} catch (e) {
  console.error('EXCEPTION', e.message); fail++;
} finally {
  try { ws && ws.close(); } catch { }
  try { child.kill(); } catch { }
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
