/* uimotion.js — 动效与微交互层（DESIGN-CONTRACT.md §4）
 * 原则：只动 transform / opacity / filter / 颜色（box-shadow 仅作为颜色的载体过渡，纯 paint 无 layout）；
 * will-change 只出现在动画 class 里，class 回收即清理；prefers-reduced-motion 下所有 API 短路成即时变化。
 * 引入顺序：在 ui.js 之前（Lead 接线）。零配置：加载后自动接管 aside#panel 的遮罩。 */
(() => {
  'use strict';
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const RM = () => !!(mq && mq.matches);

  /* ── countUp：数字滚动 ────────────────────────────────
   * "923 字" / "67%" / "2/3" / "1,024 字" 都能滚：解析数字模板，
   * 只滚数字部分，单位、分隔符、分母原样保留（textContent，绝不 innerHTML）。
   * to == null  → 占位（默认 '—'，opts.nullText 可覆盖）
   * to 非数字   → 直写不滚
   * from == null→ 用 el 当前文本当起点 */
  const NUM = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;
  const decOf = (n) => { const i = String(n).indexOf('.'); return i < 0 ? 0 : String(n).length - i - 1; };
  function tokenize(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const nums = [], ds = [];
    const tpl = s.replace(NUM, (m) => {
      nums.push(parseFloat(m.replace(/,/g, '')));
      ds.push(decOf(m));
      return '\x00' + (nums.length - 1) + '\x00';
    });
    return nums.length ? { tpl, nums, ds } : null;
  }
  const fmt = (n, d) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const paint = (tk, vals) => tk.tpl.replace(/\x00(\d+)\x00/g, (_, i) => fmt(vals[+i], tk.ds[+i]));
  function tok(v, elTok) {
    if (v == null) return elTok || null;
    if (typeof v === 'number') {
      if (elTok && elTok.nums.length === 1) return { tpl: elTok.tpl, nums: [v], ds: [decOf(v)] };
      return { tpl: '\x000\x00', nums: [v], ds: [decOf(v)] };
    }
    return tokenize(v) || elTok || null;
  }
  function countUp(el, from, to, opts) {
    if (!el) return;
    opts = opts || {};
    if (el._moCu) { cancelAnimationFrame(el._moCu); el._moCu = 0; }
    el.classList.add('mo-num');                     // tabular-nums：滚动时字宽不跳
    if (to == null) { el.textContent = opts.nullText != null ? opts.nullText : '—'; return; }
    const elTok = tokenize(el.textContent);
    const t = typeof to === 'number'                // 目标：数字继承 el 的单位模板，字符串自解析
      ? tok(to, elTok)
      : tokenize(to);
    if (!t) { el.textContent = String(to); return; }  // 非数字 → 直写
    const s = tok(from, elTok);                     // 起点：缺省用 el 当前文本
    const a = t.nums.map((v, i) => (s && i < s.nums.length ? s.nums[i] : 0));
    const fin = () => { el.textContent = paint(t, t.nums); };
    if (RM() || a.every((v, i) => v === t.nums[i])) { fin(); return; }
    const dur = opts.dur || 300, t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);  // easeOutCubic
      el.textContent = paint(t, a.map((v, i) => v + (t.nums[i] - v) * e));
      if (p < 1) el._moCu = requestAnimationFrame(step);
      else { el._moCu = 0; fin(); }
    };
    el._moCu = requestAnimationFrame(step);
    setTimeout(() => { if (el._moCu) { el._moCu = 0; fin(); } }, dur + 80); // rAF 饿死兜底
  }

  /* ── 一次性动画：animationend 即回收 class（连带 will-change） ── */
  function needRel(el) {
    if (getComputedStyle(el).position !== 'static') return null;
    el.classList.add('mo-rel');
    return 'mo-rel';
  }
  function once(el, cls, name, extra) {
    if (!el) return;
    const rel = needRel(el);
    [cls, extra].filter(Boolean).forEach((c) => el.classList.add(c));
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      el.removeEventListener('animationend', onEnd);
      [cls, extra, rel].filter(Boolean).forEach((c) => el.classList.remove(c));
    };
    const onEnd = (e) => { if (!name || e.animationName === name) cleanup(); };
    el.addEventListener('animationend', onEnd);
    setTimeout(cleanup, 1400);                      // 事件没触发也一定回收
  }
  const pulse = (el) => { if (el && !RM()) once(el, 'mo-pulse', 'mo-pulse'); };
  const flash = (el, kind) => { if (el && !RM()) once(el, 'mo-flash', 'mo-flash', 'mo-flash-' + (kind || 'info')); };

  /* ── stagger：入场波 ──────────────────────────────────
   * 少量元素每格 22ms（契约 18–25ms）；42 格时线性累加要 900ms+，
   * 超出 ≤400ms 预算 → 把全部延迟等比压缩映射到 0–200ms 区间，
   * 动画本体 200ms：总时长恒 ≤400ms，且不会退化成"一批同时蹦出来"。 */
  function stagger(container, selector) {
    const root = typeof container === 'string' ? document.querySelector(container) : container;
    if (!root) return 0;
    const els = selector ? [...root.querySelectorAll(selector)] : [...root.children];
    const n = els.length;
    if (!n || RM()) return 0;
    const step = 22, cap = 200;
    for (let i = 0; i < n; i++) {
      const el = els[i];
      const d = (n - 1) * step <= cap ? i * step : Math.round(cap * i / (n - 1));
      el.style.animationDelay = d + 'ms';
      el.classList.add('mo-enter');
      el.addEventListener('animationend', function end(e) {
        if (e.animationName !== 'mo-enter') return;
        el.removeEventListener('animationend', end);
        el.classList.remove('mo-enter');
        el.style.animationDelay = '';
      });
    }
    setTimeout(() => els.forEach((el) => {           // display:none 等路径收不到事件的兜底回收
      el.classList.remove('mo-enter');
      el.style.animationDelay = '';
    }), cap + 420);
    return n;
  }

  /* ── toast：队列，同一时刻最多 1 条 ───────────────────
   * 连发同文去重；队列只留最近 4 条（不让人排队看历史）。
   * 优先复用页面已有的 #toast（外观归 ui.css），没有则自建 .mo-toast。 */
  const TQ = [];
  let tBusy = false;
  function toastHost() {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'mo-toast';
      document.body.appendChild(t);
    }
    return t;
  }
  function toast(msg, kind) {
    kind = (kind === 'ok' || kind === 'err') ? kind : 'info';
    msg = String(msg == null ? '' : msg);
    const last = TQ[TQ.length - 1];
    if (last && last.msg === msg && last.kind === kind) return;   // 连发同文 → 去重
    TQ.push({ msg, kind });
    if (TQ.length > 4) TQ.splice(0, TQ.length - 4);               // 只留最近 4 条
    if (!tBusy) nextToast();
  }
  function nextToast() {
    const item = TQ.shift();
    if (!item) { tBusy = false; return; }
    tBusy = true;
    const t = toastHost();
    const base = (t.id === 'toast' ? 'toast' : 'mo-toast');
    t.textContent = item.msg;
    t.className = base + ' mo-on ' + item.kind;
    void t.offsetWidth;                              // 断开上一条的动画状态，重启入场
    t.className = base + ' mo-on mo-in ' + item.kind;
    let hidden = false;
    const hide = () => {
      if (hidden) return; hidden = true;
      t.classList.remove('mo-in');
      t.classList.add('mo-out');
      let fin = false;
      const done = () => {
        if (fin) return; fin = true;
        t.removeEventListener('animationend', onOut);
        t.className = base;
        tBusy = false;
        nextToast();
      };
      const onOut = (e) => { if (e.animationName === 'mo-toast-out') done(); };
      t.addEventListener('animationend', onOut);
      setTimeout(done, RM() ? 80 : 320);             // 兜底：队列一定推进
    };
    setTimeout(hide, 2200);                          // 契约：2.2s 后淡出
  }

  /* ── pending：右侧 14px 环形进度，绝对定位，按钮宽度不变 ── */
  function pending(btn, on) {
    if (!btn) return;
    on = !!on;
    const has = btn.classList.contains('mo-pending');
    if (on && !has) {
      if (getComputedStyle(btn).position === 'static') { btn.classList.add('mo-rel'); btn._moRel = 1; }
      btn.classList.add('mo-pending');
    } else if (!on && has) {
      btn.classList.remove('mo-pending');
      if (btn._moRel) { btn.classList.remove('mo-rel'); btn._moRel = 0; }
    }
  }

  /* ── skeleton：1.2s shimmer 骨架行；返回 { el, remove() } ── */
  function skeleton(container, rows) {
    const root = typeof container === 'string' ? document.querySelector(container) : container;
    if (!root) return null;
    const wrap = document.createElement('div');
    wrap.className = 'mo-skel';
    wrap.setAttribute('aria-hidden', 'true');
    const n = Math.max(1, (rows | 0) || 3);
    for (let i = 0; i < n; i++) {
      const r = document.createElement('div');
      r.className = 'mo-skel-row';
      const a = document.createElement('div'); a.className = 'mo-skel-bar l';
      const b = document.createElement('div'); b.className = 'mo-skel-bar s';
      r.append(a, b);
      wrap.appendChild(r);
    }
    root.appendChild(wrap);
    return {
      el: wrap,
      remove() {
        if (RM() || !wrap.isConnected) { wrap.remove(); return; }
        wrap.classList.add('mo-gone');
        setTimeout(() => wrap.remove(), 220);
      }
    };
  }

  /* ── stale 呼吸条：顶部 2px，唯一常驻呼吸（shimmer/spinner 除外） ── */
  let staleEl = null;
  function stale(on) {
    if (on && !staleEl) {
      staleEl = document.createElement('div');
      staleEl.className = 'mo-stale';
      document.body.appendChild(staleEl);
    }
    if (staleEl) staleEl.classList.toggle('on', !!on);
  }

  /* ── 面板遮罩：观察 aside#panel 的 open，自动挂/收 scrim（12px blur 淡入）── */
  function initPanel() {
    const panel = document.getElementById('panel');
    if (!panel || panel._moScrim) return;
    const scrim = document.createElement('div');
    scrim.className = 'mo-scrim';
    scrim.addEventListener('click', () => panel.classList.remove('open'));  // 点遮罩关面板
    panel._moScrim = scrim;
    const sync = () => {
      const on = panel.classList.contains('open');
      if (on && !scrim.isConnected) document.body.appendChild(scrim);
      scrim.classList.toggle('mo-on', on);
    };
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
    if (panel.classList.contains('open')) sync();
  }

  const boot = () => { initPanel(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Motion = {
    toast, countUp, stagger, pulse, pending, skeleton, flash,
    reduceMotion: RM,
    stale                     // 额外暴露：配置未生效（dirty）时顶部呼吸条开关
  };
})();
