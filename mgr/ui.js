const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let REG = null, DOMAINS = [], MODELS = [], filterDomains = new Set(), filterModels = new Set();
let curCell = null, dirty = false, KERNELS = [], BASE_HASH = '';
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.body.classList.add('embed');

const POST_OPS = [
  { id: 'decompose', label: '三段分解' },
  { id: 'continue', label: '续写' },
  { id: 'guard', label: '细节兜底' }
];

async function api(p, opt) {
  const r = await fetch(p, opt);
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  return r.json();
}

function toast(msg, err) {
  // 动效层接管（uimotion.js）；没加载时退回内置实现
  if (window.Motion && typeof window.Motion.toast === 'function') {
    try { window.Motion.toast(msg, err ? 'err' : 'ok'); return; } catch (e) { /* fall through */ }
  }
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), 2200);
}

function markDirty(v) {
  dirty = v;
  if (window.Motion && typeof window.Motion.stale === 'function') {
    try { window.Motion.stale(v); } catch { }   // 有未保存修改 = 配置尚未生效 → 顶部呼吸条
  }
  $('#saveState').textContent = v ? '有未保存修改' : '已同步';
  $('#saveState').style.color = v ? 'var(--warn)' : '';
}

const num = (n) => (n == null ? '' : n.toLocaleString('en-US'));

async function load() {
  const sk = (window.Motion && typeof window.Motion.skeleton === 'function')
    ? (() => { try { return window.Motion.skeleton($('#matrixWrap'), 6); } catch { return null; } })() : null;
  try {
    REG = await api('/api/registry');
    BASE_HASH = REG.__hash || '';
    DOMAINS = REG.domains || [];
    MODELS = (REG.models || []).map((m) => m.id);
    for (const r of REG.matrix || []) if (!MODELS.includes(r.model)) MODELS.push(r.model);
    try { const k = await api('/api/kernels'); KERNELS = [...(k.kernels || []), ...(k.fragments || [])]; } catch { KERNELS = []; }
    filterDomains.clear(); filterModels.clear();
    renderAll(); markDirty(false);
  } finally {
    if (sk) { try { typeof sk.remove === 'function' ? sk.remove() : (sk.parentNode && sk.parentNode.removeChild(sk)); } catch { } }
  }
}

function renderAll() {
  renderOverview(); renderFilters(); renderMatrix(); renderMethods(); renderExport();
}

// 一眼看全局：多少格靠谱、多少待改、多少还没配
function renderOverview() {
  const cells = REG.matrix || [];
  const st = { ok: 0, warn: 0, bad: 0 };
  for (const c of cells) {
    const [a, b] = String(c.evidence?.ok || '').split('/');
    if (b && a === b) st.ok++;
    else if (Number(a) > 0) st.warn++;
    else st.bad++;
  }
  const slots = DOMAINS.length * MODELS.length;
  const empty = Math.max(0, slots - cells.length);
  $('#overview').innerHTML =
    `<span class="ov-ok"><b>${st.ok}</b> 稳</span>` +
    `<span class="ov-warn"><b>${st.warn}</b> 待改</span>` +
    `<span class="ov-bad"><b>${st.bad}</b> 差</span>` +
    `<span class="ov-empty"><b>${empty}</b> 未配置</span>` +
    `<span class="spacer"></span>` +
    `<span class="muted">${MODELS.length} 模型 × ${DOMAINS.length} 域 · 已配 ${cells.length}/${slots}</span>`;
}

function renderFilters() {
  $('#domainFilter').innerHTML = DOMAINS.map((d) =>
    `<span class="chip${filterDomains.has(d.id) ? ' on' : ''}" data-d="${d.id}">${d.icon || ''} ${d.name}</span>`).join('');
  $$('#domainFilter .chip').forEach((el) => el.onclick = () => {
    const id = el.dataset.d;
    filterDomains.has(id) ? filterDomains.delete(id) : filterDomains.add(id);
    renderFilters(); applyFilters(); renderExport();
  });
  $('#modelFilter').innerHTML = MODELS.map((m) =>
    `<span class="chip${filterModels.has(m) ? ' on' : ''}" data-m="${m}">${m}</span>`).join('');
  $$('#modelFilter .chip').forEach((el) => el.onclick = () => {
    const id = el.dataset.m;
    filterModels.has(id) ? filterModels.delete(id) : filterModels.add(id);
    renderFilters(); applyFilters(); renderExport();
  });
}

function cellOf(m, d) { return (REG.matrix || []).find((r) => r.model === m && r.domain === d); }

// registry → /api/summary 同形结构（MatrixView 自带 fetch 时不用，回落路径用）
function toViewData() {
  return {
    domains: DOMAINS, models: (REG.models || []),
    cells: (REG.matrix || []).map((r) => ({
      model: r.model, domain: r.domain,
      rewrite: r.method?.rewrite ?? null, profile: r.method?.profile ?? null,
      post: r.method?.post ?? [], first: r.method?.first ?? 'raw',
      ok: r.evidence?.ok ?? null, chars: r.evidence?.chars ?? null,
      density: r.evidence?.density ?? null, retention: r.evidence?.retention ?? null,
      n: r.evidence?.n ?? null, basis: r.evidence?.basis ?? null,
      baseline: r.evidenceAuto?.ok ?? null, note: r.note ?? ''
    })),
    registry: { seq: REG.sequenceId ?? 0, stale: false }
  };
}

function renderMatrix() {
  const wrap = $('#matrixWrap');
  // 矩阵视图接管（uimatrix.js）；出错或没加载时退回内置实现
  if (window.MatrixView && typeof window.MatrixView.render === 'function') {
    try {
      // onOpen = 点击/Enter/Space 打开面板；onSelect = 选中变化（含方向键移动），不能用来开面板
      window.MatrixView.render(wrap, null, {
        fetch: '/api/summary',
        showBaseline: true,
        onOpen: (c) => { if (c && c.model) openCell(c.model, c.domain, !!c.isNew); },
        onFilterClear: () => { filterDomains.clear(); filterModels.clear(); renderFilters(); renderMatrix(); renderExport(); }
      });
      window.MatrixView.setFilters({ domains: filterDomains, models: filterModels });
      return;
    } catch (e) { console.error('MatrixView 渲染失败，回落内置实现', e); }
  }
  renderMatrixFallback(wrap);
}

// 筛选变化：矩阵接管时走 setFilters（不重建 DOM），否则重渲染整表
function applyFilters() {
  if (window.MatrixView && typeof window.MatrixView.setFilters === 'function') {
    try { window.MatrixView.setFilters({ domains: filterDomains, models: filterModels }); return; } catch { }
  }
  renderMatrix();
}

function renderMatrixFallback(wrap) {
  const dm = DOMAINS.filter((d) => !filterDomains.size || filterDomains.has(d.id));
  const ms = MODELS.filter((m) => !filterModels.size || filterModels.has(m));
  let h = '<table class="matrix"><thead><tr><th></th>';
  for (const d of dm) h += `<th>${d.icon || ''} ${d.name}</th>`;
  h += '</tr></thead><tbody>';
  for (const m of ms) {
    const mi = (REG.models || []).find((x) => x.id === m) || {};
    h += `<tr><td class="model">${m}<small>${mi.effort || ''}${mi.maxTokens ? ' · ' + Math.round(mi.maxTokens / 1000) + 'k' : ''}</small></td>`;
    for (const d of dm) {
      const c = cellOf(m, d.id);
      if (!c) { h += `<td><div class="cell empty" data-m="${m}" data-d="${d.id}">＋</div></td>`; continue; }
      const ev = c.evidence || {}, mm = c.method || {};
      const [ok, tot] = String(ev.ok || '').split('/');
      const cls = tot && ok === tot ? 'ok3' : (Number(ok) > 0 ? 'ok2' : 'ok1');
      h += `<td><div class="cell" data-m="${m}" data-d="${d.id}">
<div class="rw${mm.rewrite ? '' : ' none'}">${mm.rewrite || '原文直发'}</div>
<div class="ev"><b class="${cls}">${ev.ok || '-'}</b>${ev.chars ? ' · ' + num(ev.chars) + '字' : ''}${ev.density ? ' · 密' + ev.density : ''}${ev.retention != null ? ' · 留' + Math.round(ev.retention * 100) + '%' : ''}</div>
<div class="tagline">${c.note || mm.profile || ''}</div>
${c.evidenceAuto ? `<div class="tagline" style="color:#6b7785" title="历史全量聚合（含已淘汰方法），仅作基线参考">基线 ${c.evidenceAuto.ok} · n=${c.evidenceAuto.n}</div>` : ''}
</div></td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  wrap.innerHTML = h;
  wrap.querySelectorAll('.cell:not(.empty)').forEach((el) => el.onclick = () => openCell(el.dataset.m, el.dataset.d, false));
  wrap.querySelectorAll('.cell.empty').forEach((el) => el.onclick = () => openCell(el.dataset.m, el.dataset.d, true));
  if (window.Motion && typeof window.Motion.stagger === 'function') {
    requestAnimationFrame(() => { try { window.Motion.stagger(wrap, '.cell'); } catch { } });
  }
}

function renderMethods() {
  const t = REG.rewriteTemplates || [];
  const k = REG.kernels || [];
  const r = REG.retired || [];
  $('#methodsWrap').innerHTML =
    '<div class="card"><h3>改写规则（落点词剥离）</h3>' +
    t.map((x) => `<div style="margin:10px 0 0"><span class="id">${x.id}</span><div class="muted" style="font-size:12px">匹配：${x.match}</div>
      <div style="font-size:12px;margin-top:3px">${x.body}</div><div class="ev">证据：${x.ev}</div></div>`).join('') +
    '</div>' +
    '<div class="card"><h3>内核 / 档位</h3>' +
    k.map((x) => `<div style="margin:10px 0 0"><span class="id">${x.id}</span> <span class="muted">${x.bytes ? x.bytes + 'B' : ''}</span>
      <div style="font-size:12px">${x.note || ''}</div><div class="ev mono" style="font-size:11px">${x.src || ''}</div></div>`).join('') +
    '</div>' +
    '<div class="card"><h3>已淘汰（别再用）</h3>' +
    r.map((x) => `<div style="margin:8px 0 0"><b style="font-size:12px">${x.what}</b><div class="ev">${x.why}</div></div>`).join('') +
    '</div>';
}

function renderExport() {
  $('#exportDomains').innerHTML = DOMAINS.map((d) =>
    `<span class="chip${filterDomains.has(d.id) ? ' on' : ''}" data-d="${d.id}">${d.icon || ''} ${d.name}</span>`).join('');
  $$('#exportDomains .chip').forEach((el) => el.onclick = () => {
    const id = el.dataset.d;
    filterDomains.has(id) ? filterDomains.delete(id) : filterDomains.add(id);
    renderFilters(); renderExport();
  });
  const ds = [...filterDomains];
  const only = ds.length ? ` --domains ${ds.join(',')}` : '';
  const cmd = 'cd \\bench\n' +
    'node gwx.mjs --listen 8801 --upstream http://127.0.0.1:8788 --mode merge \\\n' +
    '  --rewrite on --detail on --first raw --guard on --guardMin 0.6 --retry 1 --maxCont 3 --budgetMs 150000' + only;
  $('#exportCmd').textContent = cmd;
  $('#exportSample').textContent =
    `POST http://127.0.0.1:8801/v1/chat/completions\n` +
    `X-Domain: ${ds[0] || 'adult'}     ← 显式指定域（跳过自动分类）\n` +
    `Content-Type: application/json\n\n` +
    `{"model":"glm-5.3-flash","stream":false,"reasoning_effort":"max","max_tokens":131072,\n` +
    ` "messages":[{"role":"user","content":"…"}]}`;
}

function openCell(m, d, isNew) {
  // 兼容传对象 {model, domain} 的调用方
  if (m && typeof m === 'object') { isNew = (d === undefined ? m.isNew : d); d = m.domain; m = m.model; }
  if (!m || !d) { console.warn('openCell 参数不完整', m, d); return; }
  curCell = { model: m, domain: d, isNew };
  const c = isNew
    ? { model: m, domain: d, method: { rewrite: null, profile: '', post: [], first: 'raw' }, evidence: {}, note: '' }
    : (cellOf(m, d) || { model: m, domain: d, method: {}, evidence: {}, note: '' });
  const dm = DOMAINS.find((x) => x.id === d) || {};
  $('#pTitle').textContent = `${m} · ${dm.name || d}`;
  $('#pMeta').textContent = isNew ? '新格子（保存后写入矩阵）' : `证据 ${c.evidence?.ok || '-'} · n=${c.evidence?.n || '?'} · ${c.evidence?.tested || ''}`;

  // 一键方案：该域预设，点一下把下面几个字段填好。用人类语言命名，内部 id 只作数据。
  const bar = $('#presetBar');
  const ps = (REG.presets || {})[d] || [];
  if (ps.length) {
    bar.innerHTML = '<div class="presets-h">这个域直接用</div>' + ps.map((p, i) =>
      `<button class="preset" data-i="${i}" title="${p.rewrite || '不改写'} + ${p.profile}">
         <b>${p.name}</b><span>${p.desc}</span></button>`).join('');
    bar.querySelectorAll('.preset').forEach((btn) => btn.onclick = () => {
      const p = ps[Number(btn.dataset.i)];
      if (!p) return;
      $('#pRewrite').value = p.rewrite || '';
      $('#pProfile').value = p.profile || '';
      $('#pFirst').value = p.first || 'raw';
      $$('#pPost input').forEach((x) => { x.checked = (p.post || []).includes(x.value); });
      bar.querySelectorAll('.preset').forEach((x) => x.classList.toggle('on', x === btn));
      if (window.Motion && window.Motion.toast) { try { window.Motion.toast(`已套用「${p.name}」，点应用生效`, 'info'); } catch { } }
    });
    // 当前配置若与某个预设完全一致，就把那个高亮
    const cur = c.method || {};
    ps.forEach((p, i) => {
      const same = (p.rewrite || null) === (cur.rewrite || null) && (p.profile || '') === (cur.profile || '')
        && JSON.stringify((p.post || []).slice().sort()) === JSON.stringify((cur.post || []).slice().sort());
      if (same) { const el = bar.querySelector(`.preset[data-i="${i}"]`); if (el) el.classList.add('on'); }
    });
  } else { bar.innerHTML = ''; }

  const rw = $('#pRewrite');
  rw.innerHTML = '<option value="">（不改写，原文直发）</option>' +
    (REG.rewriteTemplates || []).map((t) => `<option value="${t.id}">${t.label || t.id} · ${t.id}</option>`).join('');
  rw.value = c.method?.rewrite || '';
  $('#pProfile').value = c.method?.profile || '';
  $('#profileList').innerHTML = [...new Set(['slim-3k', 'v046', 'purge42k', 'kovak', 'kimiV2', 'full-42k', ...KERNELS.map((k) => k.id)])]
    .map((x) => `<option value="${x}">`).join('');
  $('#pFirst').value = c.method?.first || 'raw';
  $('#pPost').innerHTML = POST_OPS.map((o) =>
    `<label><input type="checkbox" value="${o.id}"${(c.method?.post || []).includes(o.id) ? ' checked' : ''}>${o.label}</label>`).join('');
  const ev = c.evidence || {};
  $('#pEv').textContent = Object.keys(ev).length
    ? Object.entries(ev).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '（还没有实测数据，先跑 bench 再填）';
  $('#pNote').value = c.note || '';
  $('#btnDel').style.display = isNew ? 'none' : '';
  $('#addModel').innerHTML = MODELS.map((x) => `<option>${x}</option>`).join('');
  $('#addDomain').innerHTML = DOMAINS.map((x) => `<option value="${x.id}">${x.name}</option>`).join('');
  $('#panel').classList.add('open');
}

function applyCell() {
  if (!curCell) return;
  const { model, domain, isNew } = curCell;
  const method = {
    rewrite: $('#pRewrite').value || null,
    profile: $('#pProfile').value.trim(),
    post: $$('#pPost input:checked').map((x) => x.value),
    first: $('#pFirst').value
  };
  const note = $('#pNote').value;
  REG.matrix = REG.matrix || [];
  let c = cellOf(model, domain);
  if (!c) { c = { model, domain, evidence: {} }; REG.matrix.push(c); }
  c.method = method;
  c.note = note;
  $('#panel').classList.remove('open');
  markDirty(true); renderMatrix(); renderOverview();
  toast(isNew ? '已添加格子（记得保存）' : '已更新格子（记得保存）');
}

function delCell() {
  if (!curCell || curCell.isNew) return;
  REG.matrix = (REG.matrix || []).filter((r) => !(r.model === curCell.model && r.domain === curCell.domain));
  $('#panel').classList.remove('open');
  markDirty(true); renderMatrix(); renderOverview(); toast('已删除');
}

async function save() {
  const btn = $('#btnSave');
  const pend = window.Motion && typeof window.Motion.pending === 'function';
  if (pend) { try { window.Motion.pending(btn, true); } catch { } }
  try {
    REG.updatedAt = new Date().toISOString();
    REG.__baseHash = BASE_HASH;            // 服务端据此做冲突检测
    REG.__baseSeq = REG.sequenceId ?? 0;
    const r = await api('/api/registry', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REG) });
    BASE_HASH = r.hash || BASE_HASH;
    if (r.seq != null) REG.sequenceId = r.seq;
    markDirty(false);
    if (window.Motion && typeof window.Motion.pulse === 'function') { try { window.Motion.pulse(btn); } catch { } }
    const rl = r.reloaded && r.reloaded.ok ? ` · 数据面已生效 seq=${r.reloaded.seq}` : ' · 数据面待轮询';
    toast(`已保存 seq=${r.seq} ${r.bytes}B${rl}`);
    renderMatrix();
  } catch (e) {
    const m = e.message || '';
    if (m.includes('已被其他会话修改') || m.includes('冲突')) {
      toast('保存被拒：registry 已被别处改过。点「重新载入」再改。', true);
    } else toast('保存失败：' + m, true);
  } finally {
    if (pend) { try { window.Motion.pending(btn, false); } catch { } }
  }
}

async function rebuildEvidence(apply) {
  try {
    const ev = await api('/api/evidence/rebuild' + (apply ? '?apply=1' : ''), { method: 'POST' });
    const txt = ev.cells.map((c) => `${c.model} / ${c.domain}  ${c.ok}/${c.n}  ${c.chars ?? '-'}字  n=${c.n}`).join('\n');
    if (apply) {
      toast(`已回写 ${ev.applied} 个格子（扫了 ${ev.scannedFiles} 个文件 / ${ev.scannedRows} 行）`);
      await load();
    } else {
      toast(`扫描 ${ev.scannedFiles} 个文件 / ${ev.scannedRows} 行`);
    }
    $('#resultDetail').innerHTML = `<div class="card"><h3>证据重算 <span class="muted">${ev.at}</span></h3><pre class="cmd">${esc(txt || '(没有可聚合的行)')}</pre></div>`;
  } catch (e) { toast('重建失败：' + e.message, true); }
}

async function pollGw() {
  try {
    const s = await api('/api/stats');
    $('#gwDot').className = 'dot ' + (s.online ? 'on' : 'off');
    $('#gwText').textContent = s.online ? `网关在线 · ${s.stats.requests} 请求 · ${s.gw.replace('http://', '')}` : `网关离线（${s.gw}）`;
    if (s.online) {
      const ev = s.stats.events || {};
      $('#gwDetail').innerHTML = [
        ['请求总数', s.stats.requests],
        ['原文优先命中', (ev['raw-first'] || 0)],
        ['改写后重试', (ev['staged-retry'] || 0)],
        ['续写', (ev.continue || 0)],
        ['细节兜底生效', (ev['detail-guard'] || 0)],
        ['兜底空转', (ev['guard-noop'] || 0)],
        ['上游', s.gw]
      ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
      const agg = s.stats.agg || {};
      let rows = '';
      for (const [k, v] of Object.entries(agg)) rows += `<tr><td class="mono">${k}</td><td>${v.n}</td><td class="mono">${Object.entries(v.hit || {}).map(([a, b]) => a + ':' + b).join(' ') || '—'}</td></tr>`;
      $('#pipeDetail').innerHTML = `<table class="list"><thead><tr><th>模型·档位</th><th>请求</th><th>注入命中</th></tr></thead><tbody>${rows}</tbody></table>`;
    } else {
      $('#gwDetail').innerHTML = `<b>状态</b><span class="muted">离线——启动 gwx.mjs 后刷新</span>`;
    }
  } catch { $('#gwDot').className = 'dot off'; }
}

async function loadResults() {
  const list = await api('/api/results');
  const q = ($('#resultSearch').value || '').toLowerCase();
  const shown = list.filter((x) => !q || x.name.toLowerCase().includes(q));
  $('#resultCount').textContent = `${shown.length} 个文件`;
  $('#resultsBody').innerHTML = shown.map((x) =>
    `<tr data-n="${x.name}"><td class="mono">${x.name}</td><td>${(x.size / 1024).toFixed(1)}KB</td><td class="muted">${new Date(x.mtime).toLocaleString('zh-CN')}</td></tr>`).join('');
  $$('#resultsBody tr').forEach((tr) => tr.onclick = async () => {
    const d = await api('/api/result?name=' + encodeURIComponent(tr.dataset.n));
    if (d.kind === 'text') { $('#resultDetail').innerHTML = `<div class="card"><h3>${d.name}</h3><pre class="cmd">${esc(d.text.slice(0, 12000))}</pre></div>`; return; }
    const rows = d.rows || [];
    if (!Array.isArray(rows)) { $('#resultDetail').innerHTML = `<div class="card"><pre class="cmd">${esc(JSON.stringify(rows, null, 1).slice(0, 12000))}</pre></div>`; return; }
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12);
    $('#resultDetail').innerHTML = `<div class="card"><h3>${d.name} <span class="muted">${d.count} 行</span></h3>
      <div style="max-height:420px;overflow:auto"><table class="list"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 200).map((r) => `<tr>${cols.map((c) => `<td>${esc(fmt(r[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  });
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 90));

// ── 事件 ──
$$('nav button').forEach((b) => b.onclick = () => {
  $$('nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'results') loadResults();
  if (b.dataset.view === 'gateway') pollGw();
});
$('#btnSave').onclick = save;
$('#btnRebuild').onclick = () => { if (confirm('扫描 bench 下所有 results-*.json，把实测结果写回格子？\n会覆盖现有 evidence（方法配置不动）。')) rebuildEvidence(true); };
$('#btnReload').onclick = () => { if (dirty && !confirm('有未保存修改，放弃？')) return; load(); };
$('#btnApply').onclick = applyCell;
$('#btnDel').onclick = delCell;
$('#btnClose').onclick = () => $('#panel').classList.remove('open');
$('#btnAdd').onclick = () => openCell($('#addModel').value, $('#addDomain').value, true);
$('#btnCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#exportCmd').textContent); toast('已复制'); } catch { toast('复制失败', true); } };
$('#resultSearch').oninput = loadResults;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  if (e.key === 'Escape') {
    $('#panel').classList.remove('open');
    if (curCell && window.MatrixView && typeof window.MatrixView.select === 'function') {
      try { window.MatrixView.select(curCell.model, curCell.domain); } catch { }   // 关闭后把焦点还回原格
    }
  }
});
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

load().catch((e) => toast('载入失败：' + e.message, true));
pollGw(); setInterval(pollGw, 8000);
