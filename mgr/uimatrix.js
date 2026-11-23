/* uimatrix.js —— 「模型 × 域」方法矩阵视图（Agent B，契约见 DESIGN-CONTRACT.md §3/§5）
 *
 * 输入：GET /api/summary 的响应（data.domains / data.models / data.cells / data.registry）。
 * 输出：契约固定的 <table class="mx" role="grid">，格子是 <button class="cell">。
 *
 * 用法：
 *   MatrixView.render('#matrixWrap', null, { fetch: '/api/summary', onOpen: fn })   // 骨架屏 → 自动拉取
 *   MatrixView.render('#matrixWrap', summary, { onOpen: fn, onSelect: fn, showBaseline: true })
 *   MatrixView.setFilters({ domains: Set, models: Set })   // 空集合 = 不过滤；筛后整行/整列空自动隐藏
 *   MatrixView.select('glm-5.3-flash', 'adult')            // 定位、聚焦、选中
 *   MatrixView.reload()                                    // 错误态「重试」按钮同款路径
 *
 * data 三种形态：
 *   null / undefined / {loading:true}   → 骨架屏（若 opts.fetch 存在会自动拉取）
 *   Error 实例 / {error:'...'}          → 就地错误态 + 重试按钮
 *   正常 summary                        → 矩阵
 *
 * 回调（opts 与 MatrixView 同名属性都可挂，opts 优先）：
 *   onOpen(info)     点击 / Enter / Space 触发。info = {model, domain, domainName, effort, isNew, cell, state, el}
 *                    isNew=true 表示该格还没有配置（＋格），面板应按「新建」处理。
 *   onSelect(info)   选中格变化（点击、方向键、select()）触发；info 同上。
 *   onFilterClear()  顶部「清除筛选」被点（Lead 需同步 chip 视觉状态）。
 *
 * 冒泡事件（Lead 可在 #matrixWrap 上监听）：
 *   'mx-retry'       错误态「重试」被点（组件随后会自己重拉，若 opts.fetch 存在）
 *   'mx-filterclear' 「清除筛选」被点
 *
 * 键盘：↑↓←→ 移动（边界回绕），Home/End 行首行尾（Ctrl+Home/End 跳全表首尾），Enter/Space 打开。
 * 无障碍：role=grid / row / gridcell，roving tabindex（任意时刻只有一个 tabindex=0），
 *         每格 aria-label「模型X 在 域Y：方法…，成功率…」。
 * 性能：template.content（DocumentFragment）一次 replaceChildren 插入；click/keydown 全部委托在根节点。
 *
 * 单实例组件：render 的 container 是当前挂载点，重复 render 即换数据/换容器。
 */
(function () {
  'use strict';

  var S = {
    container: null, data: null, opts: {},
    filters: { domains: new Set(), models: new Set() },
    N: null,      // normalize(data)：{domains, models, map, stale, missing, seq, loadedSeq}
    V: null,      // 当次可见范围：{doms, mods, active}
    grid: [],     // grid[r][c] -> button.cell
    sel: null,    // {model, domain} 选中格
    focus: null,  // {model, domain} roving tabindex 所在格
    root: null    // 当前 .mx-root
  };

  /* ── 工具 ─────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var num = function (n) { return n == null ? '' : Number(n).toLocaleString('en-US'); };

  // "2/3" → {a:2, b:3}；非法 / 无数据 → null
  function parseOk(ok) {
    if (ok == null || ok === '') return null;
    var m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(ok));
    if (!m) return null;
    var a = +m[1], b = +m[2];
    if (!b) return null;
    return { a: a, b: b };
  }

  // 状态映射：ok==total → ok；ok>0 → warn；ok==0 → bad；无数据 → empty
  function stateOf(rec) {
    if (!rec) return 'empty';
    var p = parseOk(rec.ok);
    if (!p) return 'empty';
    if (p.a >= p.b) return 'ok';
    if (p.a === 0) return 'bad';
    return 'warn';
  }

  function metricsOf(rec) {
    if (!rec) return '';
    var out = [];
    if (rec.chars != null && rec.chars !== '') out.push(num(rec.chars) + ' 字');
    if (rec.density != null && rec.density !== '') out.push('密 ' + rec.density);
    if (rec.retention != null && rec.retention !== '') out.push('留 ' + Math.round(rec.retention * 100) + '%');
    return out.join(' · ');
  }

  function modelMeta(m) {
    var out = [];
    if (m.effort) out.push(m.effort);
    if (m.maxTokens) out.push(Math.round(m.maxTokens / 1000) + 'k');
    return out.join(' · ');
  }

  function normalize(data) {
    var domains = (data.domains || []).slice().sort(function (x, y) {
      return (y.priority || 0) - (x.priority || 0) || String(x.id).localeCompare(String(y.id));
    });
    var models = (data.models || []).filter(Boolean).map(function (m) {
      return { id: m.id, effort: m.effort || null, maxTokens: m.maxTokens || null };
    });
    var seen = new Set(models.map(function (m) { return m.id; }));
    (data.cells || []).forEach(function (c) {          // 防御：matrix 里出现清单外模型也给行
      if (c && c.model && !seen.has(c.model)) { seen.add(c.model); models.push({ id: c.model, effort: null, maxTokens: null }); }
    });
    var map = new Map();
    (data.cells || []).forEach(function (c) {
      if (c && c.model && c.domain) map.set(c.model + '|' + c.domain, c);
    });
    var reg = data.registry || {};
    return {
      domains: domains, models: models, map: map,
      stale: reg.stale === true, missing: reg.missing === true,
      seq: reg.seq == null ? null : reg.seq, loadedSeq: reg.loadedSeq == null ? null : reg.loadedSeq
    };
  }

  // 可见范围：空集合 = 不过滤；有筛选时，整行/整列全空的自动隐藏
  function computeVisible(N) {
    var fd = S.filters.domains, fm = S.filters.models;
    var active = !!(fd && fd.size) || !!(fm && fm.size);
    var doms = N.domains, mods = N.models;
    if (fd && fd.size) doms = doms.filter(function (d) { return fd.has(d.id); });
    if (fm && fm.size) mods = mods.filter(function (m) { return fm.has(m.id); });
    if (active) {
      var occ = function (m, d) { return N.map.has(m + '|' + d); };
      doms = doms.filter(function (d) { return mods.some(function (m) { return occ(m.id, d.id); }); });
      mods = mods.filter(function (m) { return doms.some(function (d) { return occ(m.id, d.id); }); });
    }
    return { doms: doms, mods: mods, active: active };
  }

  function isErr(d) { return d instanceof Error || (!!d && typeof d.error === 'string'); }
  function isTransient(d) { return d == null || isErr(d) || (d && d.loading === true); }
  function errMsg(d) { return d instanceof Error ? (d.message || String(d)) : (d && d.error) || ''; }

  /* ── HTML 构造（契约 §3 类名固定）────────────────── */

  function barHtml(V, N) {
    var h = '<div class="mx-bar">';
    if (V.active) {
      h += '<span class="mx-fb">已筛 ' + V.mods.length + '/' + N.models.length + ' 模型 · '
        + V.doms.length + '/' + N.domains.length + ' 域</span>'
        + '<button type="button" class="mx-fb-clear">清除筛选</button>';
    }
    if (N.stale) {
      h += '<span class="mx-stale" role="status">配置未生效：已保存 seq ' + (N.seq == null ? '?' : N.seq)
        + (N.loadedSeq != null ? '，网关仍在跑 seq ' + N.loadedSeq : '') + '</span>';
    }
    return h + '</div>';
  }

  function cellHtml(m, d, r, c) {
    var N = S.N;
    var rec = N.map.get(m.id + '|' + d.id) || null;
    var st = stateOf(rec);
    var isNew = !rec;
    var rw = rec ? (rec.rewrite || null) : null;
    var okTxt = (rec && rec.ok != null && rec.ok !== '') ? String(rec.ok) : null;
    var showBase = S.opts.showBaseline !== false;
    var stale = N.stale;
    var domName = d.name || d.id;
    var sel = !!(S.sel && S.sel.model === m.id && S.sel.domain === d.id);

    var aria = isNew
      ? (m.id + ' 在 ' + domName + '：未配置方法，点击或回车新建')
      : (m.id + ' 在 ' + domName + '：' + (rw ? '改写规则 ' + rw : '原文直发') + '，' + (okTxt ? '成功率 ' + okTxt : '暂无实测'));

    var tl = [m.id + ' · ' + domName];
    if (rec) {
      tl.push((rw || '原文直发') + (okTxt ? ' · ' + okTxt : '') + (rec.basis ? ' · ' + rec.basis : ''));
      var met = metricsOf(rec); if (met) tl.push(met);
      if (showBase && rec.baseline) tl.push('基线 ' + rec.baseline + '（历史聚合，含已淘汰方法）');
      if (rec.note) tl.push(rec.note);
    } else tl.push('点击新建');

    var b = '<button type="button" class="cell" tabindex="-1"'
      + ' data-m="' + esc(m.id) + '" data-d="' + esc(d.id) + '"'
      + ' data-state="' + st + '" data-r="' + r + '" data-c="' + c + '"';
    if (isNew) b += ' data-new="1"';
    else if (!rw) b += ' data-rw="none"';
    if (stale) b += ' data-stale="1"';
    if (sel) b += ' data-selected="1"';
    b += ' aria-label="' + esc(aria) + '" title="' + esc(tl.join('\n')) + '">';

    if (isNew) {
      b += '<span class="cell-add" aria-hidden="true">＋</span>';
    } else {
      b += '<span class="cell-rw">' + esc(rec.rewriteLabel || rw || '原文直发') + '</span>';
      b += '<span class="cell-ok">' + esc(okTxt || '未测') + '</span>';
      b += '<span class="cell-metrics">' + esc(metricsOf(rec)) + '</span>';
      var note = rec.note || rec.profile || '';
      b += '<span class="cell-note"' + (note ? ' title="' + esc(note) + '"' : '') + '>' + esc(note) + '</span>';
      if (showBase && rec.baseline) {
        b += '<span class="cell-base" title="历史聚合基线（含已淘汰方法的实验），仅作参考">基线 ' + esc(String(rec.baseline)) + '</span>';
      }
    }
    b += '</button>\n';   // 换行：让 headless dump 逐格一行，方便 Select-String 计数
    return '<td class="mx-c" role="gridcell"' + (sel ? ' aria-selected="true"' : '') + '>' + b + '</td>';
  }

  function tableHtml() {
    var N = S.N, V = S.V;
    var h = '<div class="mx-root"' + (N.stale ? ' data-stale="1"' : '') + '>';
    if (V.active || N.stale) h += barHtml(V, N);
    h += '<div class="mx-scroll"><table class="mx" role="grid" aria-label="模型 × 域方法矩阵"><thead><tr>';
    h += '<th class="mx-corner" scope="col"></th>';
    V.doms.forEach(function (d) {
      h += '<th class="mx-h" scope="col" role="columnheader" title="' + esc(d.name || d.id) + '">'
        + esc((d.icon ? d.icon + ' ' : '') + (d.name || d.id)) + '</th>';
    });
    h += '</tr></thead><tbody>';
    V.mods.forEach(function (m, r) {
      var meta = modelMeta(m);
      h += '<tr class="mx-r" role="row"><th class="mx-model" scope="row" role="rowheader">'
        + '<span class="mx-model-id" title="' + esc(m.id) + '">' + esc(m.id) + '</span>'
        + (meta ? '<span class="mx-model-meta">' + esc(meta) + '</span>' : '')
        + '</th>';
      V.doms.forEach(function (d, c) { h += cellHtml(m, d, r, c); });
      h += '</tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  function skeletonHtml() {
    var h = '<div class="mx-root" data-state="loading"><div class="mx-scroll">'
      + '<div class="mx-skel-grid" role="status" aria-label="矩阵载入中">';
    for (var i = 0; i < 18; i++) h += '<span class="mx-skel"></span>';
    return h + '</div></div></div>';
  }

  function msgHtml(kind, title, detail, btn, btnClass) {
    return '<div class="mx-root" data-state="' + kind + '"><div class="mx-msg">'
      + '<span class="mx-msg-t">' + esc(title) + '</span>'
      + (detail ? '<span class="mx-msg-d">' + esc(detail) + '</span>' : '')
      + (btn ? '<button type="button" class="' + btnClass + '">' + esc(btn) + '</button>' : '')
      + '</div></div>';
  }

  /* ── 渲染 ─────────────────────────────────────────── */

  function paint(container, data, opts) {
    S.container = container;
    S.opts = opts || {};
    if (data !== undefined) S.data = data;
    var d = S.data;

    var kind = 'grid';
    if (isErr(d)) kind = 'error';
    else if (d == null || (d && d.loading === true)) kind = 'loading';
    else {
      S.N = normalize(d);
      S.V = computeVisible(S.N);
      if (S.N.missing || (S.N.domains.length === 0 && S.N.models.length === 0)) kind = 'empty';
      else if (S.V.mods.length === 0 || S.V.doms.length === 0) kind = S.V.active ? 'filtered' : 'empty';
    }

    var html;
    if (kind === 'loading') html = skeletonHtml();
    else if (kind === 'error') html = msgHtml('error', '矩阵载入失败', errMsg(d) || '未知错误', '重试', 'mx-retry');
    else if (kind === 'empty') html = msgHtml('empty', '矩阵还是空的',
      (S.N && S.N.missing) ? 'registry.json 缺失或损坏，修复后重新载入。' : '还没有任何模型 × 域的数据，先跑 bench 或写入 registry。',
      '重新载入', 'mx-retry');
    else if (kind === 'filtered') html = msgHtml('filtered', '筛选后没有匹配的格子', '换一组域 / 模型，或清除筛选。', '清除筛选', 'mx-clear');
    else html = tableHtml();

    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var frag = tpl.content;                 // DocumentFragment
    var root = frag.firstElementChild;
    if (root) {                             // 事件委托（插入前绑，插入后生效）
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', onKey);
    }
    var hadFocus = container.contains(document.activeElement);
    container.replaceChildren(frag);        // 一次性插入
    S.root = root;

    if (kind === 'grid') {
      S.grid = [].map.call(root.querySelectorAll('tbody tr'), function (tr) {
        return [].slice.call(tr.querySelectorAll('button.cell'));
      });
      restoreFocus(hadFocus);
    } else {
      S.grid = [];
    }
    return root;
  }

  function restoreFocus(hadFocus) {
    var R = S.grid.length, C = R ? S.grid[0].length : 0;
    if (!R || !C) return;
    var btn = (S.focus && findBtn(S.focus.model, S.focus.domain))
      || (S.sel && findBtn(S.sel.model, S.sel.domain))
      || S.grid[0][0];
    setTab(btn);
    if (hadFocus) btn.focus();
  }

  function findBtn(m, d) {
    for (var i = 0; i < S.grid.length; i++)
      for (var j = 0; j < S.grid[i].length; j++) {
        var b = S.grid[i][j];
        if (b.dataset.m === m && b.dataset.d === d) return b;
      }
    return null;
  }

  // roving tabindex：全表只有一格 tabindex=0
  function setTab(btn) {
    for (var i = 0; i < S.grid.length; i++)
      for (var j = 0; j < S.grid[i].length; j++)
        if (S.grid[i][j] !== btn) S.grid[i][j].tabIndex = -1;
    btn.tabIndex = 0;
    S.focus = { model: btn.dataset.m, domain: btn.dataset.d };
  }

  /* ── 交互 ─────────────────────────────────────────── */

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var cell = t.closest('button.cell');
    if (cell) { activate(cell); return; }
    if (t.closest('.mx-fb-clear') || t.closest('.mx-clear')) { clearFilters(); return; }
    if (t.closest('.mx-retry')) { reload(); return; }
  }

  function onKey(e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest('button.cell') : null;
    if (!btn) return;
    var R = S.grid.length;
    if (!R) return;
    var C = S.grid[0].length;
    var r = +btn.dataset.r, c = +btn.dataset.c;
    var k = e.key;

    if (k === 'Enter' || k === ' ' || k === 'Spacebar') { e.preventDefault(); activate(btn); return; }

    var hit = true;
    if (k === 'ArrowUp') r = (r - 1 + R) % R;
    else if (k === 'ArrowDown') r = (r + 1) % R;
    else if (k === 'ArrowLeft') c = (c - 1 + C) % C;
    else if (k === 'ArrowRight') c = (c + 1) % C;
    else if (k === 'Home') { c = 0; if (e.ctrlKey || e.metaKey) r = 0; }
    else if (k === 'End') { c = C - 1; if (e.ctrlKey || e.metaKey) r = R - 1; }
    else hit = false;
    if (!hit) return;

    e.preventDefault();                     // 方向键不滚动页面
    var next = S.grid[r] && S.grid[r][c];
    if (next) setActive(next, { focus: true, fire: true });
  }

  // 移动 roving tabindex + 更新选中态；o.focus 聚焦，o.fire 触发 onSelect
  function setActive(btn, o) {
    if (!btn) return;
    setTab(btn);
    if (S.root) {
      var prev = S.root.querySelectorAll('button.cell[data-selected]');
      for (var i = 0; i < prev.length; i++) {
        prev[i].removeAttribute('data-selected');
        var td = prev[i].closest('td'); if (td) td.removeAttribute('aria-selected');
      }
    }
    btn.setAttribute('data-selected', '1');
    var td2 = btn.closest('td'); if (td2) td2.setAttribute('aria-selected', 'true');
    S.sel = { model: btn.dataset.m, domain: btn.dataset.d };
    if (o && o.focus) btn.focus();
    if (o && o.fire) fire('onSelect', cellInfo(btn));
  }

  // 点击 / Enter / Space：选中 + 打开
  function activate(btn) {
    setActive(btn, { fire: true });
    fire('onOpen', cellInfo(btn));
  }

  function cellInfo(btn) {
    var m = btn.dataset.m, d = btn.dataset.d;
    var rec = (S.N && S.N.map.get(m + '|' + d)) || null;
    var dom = S.N && S.N.domains.filter(function (x) { return x.id === d; })[0];
    var mod = S.N && S.N.models.filter(function (x) { return x.id === m; })[0];
    return {
      model: m, domain: d,
      domainName: dom ? (dom.name || d) : d,
      effort: mod ? (mod.effort || null) : null,
      isNew: !rec,                          // true = ＋格，面板按「新建」处理
      cell: rec,                            // 原始 summary 行（含 rewrite/profile/post/first/ok/...）
      state: btn.dataset.state,
      el: btn
    };
  }

  function fire(name, info) {
    var fn = (S.opts && S.opts[name]) || MatrixView[name];
    if (typeof fn === 'function') {
      try { fn(info); } catch (e) { try { console.error('[MatrixView] ' + name + ' 回调抛错', e); } catch (e2) { } }
    }
  }

  function clearFilters() {
    S.filters = { domains: new Set(), models: new Set() };
    redraw();
    fire('onFilterClear', { domains: S.filters.domains, models: S.filters.models });
    if (S.container) {
      try { S.container.dispatchEvent(new CustomEvent('mx-filterclear', { bubbles: true })); } catch (e) { }
    }
  }

  function redraw() {
    if (!S.container) return null;
    paint(S.container, undefined, S.opts);
    return info();
  }

  function info() {
    var V = S.V, N = S.N;
    if (!V || !N) return { models: 0, domains: 0, cells: 0, occupied: 0, filtered: false };
    var occupied = 0;
    V.mods.forEach(function (m) {
      V.doms.forEach(function (d) { if (N.map.has(m.id + '|' + d.id)) occupied++; });
    });
    return {
      models: V.mods.length, domains: V.doms.length,
      cells: V.mods.length * V.doms.length, occupied: occupied, filtered: V.active
    };
  }

  /* ── 拉取（骨架 / 错误重试共用）───────────────────── */

  function fetchPromise(f) {
    if (typeof f === 'function') return Promise.resolve().then(f);
    if (typeof f === 'string') return fetch(f).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    return null;
  }

  function runFetch() {
    var p = fetchPromise(S.opts && S.opts.fetch);
    if (!p) return null;
    return p.then(function (d) {
      if (isTransient(S.data)) paint(S.container, d, S.opts);
      return d;
    }, function (e) {
      if (isTransient(S.data)) paint(S.container, e, S.opts);
      return null;
    });
  }

  function reload() {
    if (S.container) {
      try { S.container.dispatchEvent(new CustomEvent('mx-retry', { bubbles: true })); } catch (e) { }
    }
    var hasFetch = S.opts && (typeof S.opts.fetch === 'function' || typeof S.opts.fetch === 'string');
    if (!hasFetch) return null;             // 无 fetch 来源：Lead 监听 mx-retry 自行重载
    paint(S.container, null, S.opts);       // 先回骨架屏
    return runFetch();
  }

  /* ── 公开 API ─────────────────────────────────────── */

  function render(container, data, opts) {
    if (typeof container === 'string') container = document.querySelector(container);
    if (!container) return null;
    var root = paint(container, data, opts || {});
    if (data == null && opts && opts.fetch) runFetch();   // 骨架 + 自动拉取
    return root;
  }

  function toSet(v) {
    if (!v) return new Set();
    if (v instanceof Set) return new Set(v);
    if (Array.isArray(v) || (typeof v[Symbol.iterator] === 'function')) return new Set(v);
    return new Set();
  }

  function setFilters(filters) {
    var f = filters || {};
    S.filters = { domains: toSet(f.domains), models: toSet(f.models) };
    return redraw();
  }

  function select(model, domain) {
    if (!S.grid.length) return false;
    var btn = findBtn(model, domain);
    if (!btn) return false;
    setActive(btn, { focus: true, fire: true });
    return true;
  }

  window.MatrixView = {
    render: render,
    setFilters: setFilters,
    select: select,
    reload: reload,
    onSelect: null,          // 全局选中回调（opts.onSelect 优先）
    onFilterClear: null,     // 全局「清除筛选」回调（opts.onFilterClear 优先）
    get filters() { return { domains: new Set(S.filters.domains), models: new Set(S.filters.models) }; },
    get data() { return S.data; },   // 当前渲染的数据（错误态时是 Error 实例）
    version: '1.0.0'
  };
})();
