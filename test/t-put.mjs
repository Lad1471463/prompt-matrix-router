// t-put.mjs — 验证写入路径：hash 令牌 / reload 推送 / 陈旧 hash 409 / 并发互斥
const B = process.env.MGR_URL || 'http://127.0.0.1:8899';
const get = async () => (await fetch(B + '/api/registry')).json();
const put = async (obj, hash) => {
  const r = await fetch(B + '/api/registry', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...obj, __baseHash: hash })
  });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, j };
};

let reg = await get();
console.log('GET seq=', reg.sequenceId, 'hash=', reg.__hash.slice(0, 12));

// 1) 正常写 + 是否推动数据面重载
let t0 = Date.now();
const a = await put({ ...reg, note: (reg.note || '') + ' [t1]' }, reg.__hash);
console.log('PUT#1', a.status, 'ms=', Date.now() - t0, 'seq=', a.j?.seq,
  'reloaded=', JSON.stringify(a.j?.reloaded));

// 2) 用刚过期的 hash 再写 → 应 409
const b = await put({ ...reg, note: 'stale' }, reg.__hash);
console.log('PUT#2 (stale hash)', b.status, b.j?.error || '');

// 3) 无令牌 → 428
const r3 = await fetch(B + '/api/registry', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matrix: [] }) });
console.log('PUT#3 (no token)', r3.status);

// 4) 并发 8 写，同一基线 hash → 期望 1×200 + 7×409
reg = await get();
const conc = await Promise.all(Array.from({ length: 8 }, (_, i) =>
  put({ ...reg, note: 'conc-' + i }, reg.__hash).then((r) => r.status)));
const tally = conc.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
console.log('并发 8 写 →', JSON.stringify(tally));

// 5) 最终一致性：summary 的 loadedSeq 应等于当前 seq
const s = await (await fetch(B + '/api/summary')).json();
console.log('summary reg.seq=', s.registry.seq, 'loadedSeq=', s.registry.loadedSeq, 'stale=', s.registry.stale,
  'cells=', s.cells.length, 'gw=', s.gateway.online);
