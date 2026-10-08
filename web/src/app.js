// 页面逻辑：物品面板选目标 → 外部供应弹窗 → 交给后台线程规划 → 画图纸、填标题栏、给出蓝图字符串。
/* global WORKER_SRC */
import { SPRITE, glyphSvg } from './glyphs.js';
import { sliceRoutes, drawingSvg, routeColor } from './drawing.js';
import { createViewer } from './viewer.js';
import { readHandoff } from './handoff.js';

const $ = (id) => document.getElementById(id);
const STORE = 'dsp-handcraft:settings';
const DEFAULTS = { targetId: 1204, rate: 90, ext: [], recipes: {}, assembler: '2303', smelter: '2302', chemical: '2309', lab: '2901', labstack: 15, belt: '3', sorter: '2013', power: 'tesla', station: '', pile: '1', spray: '0', split: '0', stitch: '1', proslot: '1', warper: '0', maxwidth: '', maxheight: '', aspect: '3', orient: 'h', effort: 'quick', page: 1, chemtight: '0', burn: [] };
const OPTION_NAMES = ['assembler', 'smelter', 'chemical', 'chemtight', 'lab', 'belt', 'sorter', 'station', 'pile', 'power', 'spray', 'split', 'stitch', 'proslot', 'warper', 'maxwidth', 'maxheight', 'aspect', 'effort']; // 排布方向去掉了，统一横排（用户 2026/10/07）
// 物品类别色条（游戏物品类型）：原矿、材料、组件、成品、物流、生产设施、防御、黑雾、矩阵
const CAT_COLOR = { 1: '#9aa5b1', 2: '#6f8fb3', 3: '#5f9b8b', 4: '#b48b52', 5: '#7c80c0', 6: '#4f7cc9', 8: '#b56262', 9: '#b56262', 10: '#707070', 11: '#9a72cf' };
const STATUS_TEXT = {
  ok: '只用熔炉、制造台和化工厂就能做',
  partial: '产线里有原油精炼厂等，选中后会请你把相关中间产物设为外部供应',
  self: '本身需要原油精炼厂等暂不支持的工厂，不能作为目标',
  none: '没有常规的单产物配方，不能作为目标',
  raw: '原矿，不能作为目标',
};

document.body.insertAdjacentHTML('afterbegin', SPRITE);

let catalog = [];
let byId = new Map();
const state = { ...DEFAULTS, ext: new Set() };
let floors = [];
const view = { level: 0, focus: '', selected: '', buildings: true, sorters: true, power: false };
let last = null;
let split = null; // 切成几块时整个结果（每块的结果在 split.modules 里），不切时为空
let busy = false;
let reqId = 0;
let catId = 0;
let chainId = 0;
let chainData = null;
let autoSuggest = false;
let iconMode = false; // 页面旁边有 icons/ 目录时改用其中的图片
let pickMode = { add: true }; // 物品面板这次是添加目标还是更换第 i 个目标

const viewer = createViewer({ box: $('drawing'), enabled: () => true, onSelect: selectRoute, onClear: clearRoute, onZoom: (n) => $('zoom-label').textContent = `${n}%`, zoomable: () => $('sheet').classList.contains('is-expanded') });

// ---------- 后台线程（打不开时退回到主线程运行） ----------
// 有的浏览器不允许本地文件启动后台线程，而且是异步报错；在第一条回复到达之前出错就整体切到主线程。
function inlineRunner() {
  const api = { onmessage: null, postMessage: null };
  const inner = { onmessage: null, postMessage: (data) => setTimeout(() => api.onmessage && api.onmessage({ data })) };
  new Function('self', WORKER_SRC)(inner);
  api.postMessage = (data) => setTimeout(() => inner.onmessage({ data }));
  return api;
}
let runner = null;
let ready = false;
const pending = [];
function send(msg) {
  pending.push(msg);
  runner.postMessage(msg);
}
function attach(r) {
  runner = r;
  runner.onmessage = (ev) => {
    ready = true;
    pending.length = 0;
    handle(ev.data);
  };
}
function fallBack() {
  if (ready) return;
  attach(inlineRunner());
  for (const m of pending.splice(0)) send(m);
}
try {
  const w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
  attach(w);
  w.onerror = (e) => {
    if (!ready) {
      e.preventDefault?.();
      fallBack();
    } else {
      setStatus(`后台计算出错：${e.message || '未知错误'}`, true);
      setBusy(false);
    }
  };
} catch {
  attach(inlineRunner());
}
function handle(m) {
  if (m.type === 'catalog' && m.id === catId) {
    catalog = m.list;
    byId = new Map(catalog.map((x) => [x.id, x]));
    migrateTarget();
    takeHandoffExt();
    renderCatalog();
    renderSpec();
  } else if (m.type === 'progress' && m.id === reqId) {
    progress = { ...progress, ...m, est0: progress?.est0 ?? m.est ?? null }; // est0 是开搜前报的第一个预计，之后不改
  } else if (m.type === 'preview' && m.id === reqId) {
    onPreview(m); // 搜索中的快照：观摩退火
  } else if (m.type === 'chain' && m.id === chainId) {
    onChain(m.data);

  } else if (m.type === 'take-failed' && m.id === reqId) {
    // 「就这个蓝图了」没收成（比如这一张接不上物流站）：说一句，按钮还能再点，搜索照常
    $('preview-note').textContent = m.reason;
    $('take').disabled = !preview?.drawnModel;
    $('take').textContent = '就这个蓝图了';
  } else if (m.type === 'result' && m.id === reqId) {
    finish(m.data);
  }
}

// ---------- 设置的保存与读取 ----------
function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(STORE) || '{}');
  } catch {
    /* 无痕模式等情况下读不到，使用默认值 */
  }
  Object.assign(state, DEFAULTS, s);
  // 排布方向：上一版默认「自动」，效果不好，改回默认横排；那时存下的「自动」当作没选过（以后自己选的才记，见 orientPicked）
  if (state.orient === 'auto' && !s.orientPicked) state.orient = 'h';
  // 旧版本存的是物品名和逗号分隔的外部供应
  // 新配方：{ 物品 ID: 配方 ID }，只记开了新配方的物品
  state.recipes = s.recipes && typeof s.recipes === 'object' ? Object.fromEntries(Object.entries(s.recipes).filter(([, v]) => Number(v) > 0)) : {};
  state.burn = Array.isArray(s.burn) ? s.burn.map(Number).filter(Boolean) : []; // 1.8 存的是 '0' / '1'（左栏开关），改到弹窗后按物品记
  state.ext = new Set(Array.isArray(s.ext) ? s.ext : typeof s.raw === 'string' ? s.raw.split(/[,，、\s]+/).filter(Boolean) : []);
  state.legacyTarget = typeof s.target === 'string' ? s.target : null;
  // 多个目标：旧版本只有 targetId/rate
  state.targets = Array.isArray(s.targets) && s.targets.length ? s.targets.map((t) => ({ id: Number(t.id), rate: Number(t.rate) || 60 })) : [{ id: Number(s.targetId ?? DEFAULTS.targetId), rate: Number(s.rate ?? DEFAULTS.rate) }];
  // 自动切分：没自己选过时，最终产物多于一个就默认开（用户 2026/10/06）
  state.splitPicked = !!s.splitPicked;
  if (!state.splitPicked) state.split = state.targets.length > 1 ? '1' : '0';
  for (const name of OPTION_NAMES) {
    const el = document.querySelector(`input[name="${name}"][value="${state[name]}"]`) || document.querySelector(`input[name="${name}"][value="${DEFAULTS[name]}"]`);
    el.checked = true;
  }
  state.labstack = labStackOf(state.labstack);
  $('labstack').value = state.labstack;
}
/** 研究站最多叠几层：1~15 的整数（游戏里垂直建造满级 15 层） */
const labStackOf = (v) => Math.max(1, Math.min(15, Math.round(Number(v)) || DEFAULTS.labstack));
function migrateTarget() {
  if (!state.legacyTarget) return;
  const hit = catalog.find((x) => x.name === state.legacyTarget);
  if (hit) state.targets[0].id = hit.id;
  state.legacyTarget = null;
}
function readOptions() {
  for (const name of OPTION_NAMES) state[name] = document.querySelector(`input[name="${name}"]:checked`)?.value ?? DEFAULTS[name];
  state.labstack = labStackOf($('labstack').value);
  document.querySelectorAll('#goals input[data-i]').forEach((el) => (state.targets[Number(el.dataset.i)].rate = Number(el.value)));
}
function saveSettings() {
  try {
    const rest = { ...state };
    delete rest.legacyTarget;
    localStorage.setItem(STORE, JSON.stringify({ ...rest, ext: [...state.ext], orientPicked: state.orient === 'auto' }));
  } catch {
    /* 忽略 */
  }
}

// 新版下拉框与旧版单选按钮共用同一组选项及设置。
function initOptionSelects() {
  document.querySelectorAll('.seg[data-name]').forEach((field) => {
    const name = field.dataset.name;
    const label = field.querySelector('legend').textContent;
    const options = [...field.querySelectorAll('input[type="radio"]')];
    field.insertAdjacentHTML('beforeend', `<label class="modern-option"><span>${esc(label)}</span><select data-option-select="${name}" aria-label="${esc(label)}">${options.map((el) => `<option value="${esc(el.value)}">${esc(el.nextElementSibling.textContent)}</option>`).join('')}</select></label>`);
    const select = field.querySelector('select');
    select.addEventListener('change', () => {
      const radio = options.find((el) => el.value === select.value);
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    });
    options.forEach((radio) => radio.addEventListener('change', () => {
      select.value = radio.value;
      readOptions();
      saveSettings();
    }));
  });
}
function syncOptionSelects() {
  document.querySelectorAll('[data-option-select]').forEach((select) => {
    select.value = document.querySelector(`input[name="${select.dataset.optionSelect}"]:checked`).value;
  });
}

// ---------- 物品面板（弹窗） ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// 物品图示：默认是自绘线条图形；icons/ 目录里有对应 png 时用图片
function pic(x) {
  const c = x.icon !== undefined ? x : catalog.find((y) => y.name === x.name) || x;
  // 图片缺失时删掉 img，后面紧跟的线条图形就会显示出来
  const src = window.DSPHC?.icon?.(c); // 嵌在别的网页里时由那边给图标（见下面的 dsphc-icons）
  if (src) return `<img class="gl pic" src="${esc(src)}" alt="" onerror="this.remove()">${glyphSvg(x)}`;
  if (iconMode && c.icon) return `<img class="gl pic" src="icons/${esc(c.icon)}.png" alt="" onerror="this.remove()">${glyphSvg(x)}`;
  return glyphSvg(x);
}
const tileInner = (it) => `${pic(it)}<span class="nm">${esc(it.name)}</span>`;
function renderCatalog() {
  const items = catalog.filter((x) => x.page === state.page);
  if (!items.length) {
    $('slots').innerHTML = '<p class="hint">物品列表加载中…</p>';
    return;
  }
  const rows = Math.max(...items.map((x) => x.row));
  const at = new Map(items.map((x) => [`${x.row},${x.col}`, x]));
  const q = $('find').value.trim();
  const html = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= 14; c++) {
      const it = at.get(`${r},${c}`);
      if (!it) {
        html.push('<div class="slot" aria-hidden="true"></div>');
        continue;
      }
      const off = it.status !== 'ok' && it.status !== 'partial';
      const cls = ['tile', `st-${it.status}`, state.targets.some((t) => t.id === it.id) ? 'is-target' : '', off ? 'is-off' : '', q ? (it.name.includes(q) ? 'is-hit' : 'is-dim') : ''].join(' ');
      const tip = `${it.name}：${STATUS_TEXT[it.status]}`;
      html.push(
        `<button type="button" class="${cls}" style="--cat:${CAT_COLOR[it.type] || '#9aa5b1'}" data-id="${it.id}" title="${esc(tip)}" aria-label="${esc(tip)}"${off ? ' aria-disabled="true"' : ''}>${tileInner(it)}</button>`,
      );
    }
  }
  $('slots').innerHTML = html.join('');
}
$('slots').addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (!t) return;
  const it = byId.get(Number(t.dataset.id));
  if (it.status !== 'ok' && it.status !== 'partial') {
    $('pick-msg').textContent = `${it.name}：${STATUS_TEXT[it.status]}。`;
    return;
  }
  $('pick-msg').textContent = '';
  $('suggest').hidden = true;
  readOptions();
  const dup = state.targets.findIndex((t) => t.id === it.id);
  let changed = false;
  if (pickMode.add) {
    if (dup < 0) {
      state.targets.push({ id: it.id, rate: 60 });
      changed = true;
    }
  } else if (dup < 0) {
    state.targets[pickMode.index].id = it.id;
    changed = true;
    // 只有一个目标时换目标，外部供应从头来
    if (state.targets.length === 1) state.ext = new Set();
  }
  if (changed) autoSuggest = true; // 新目标：先按建议把需要原油精炼厂等的中间产物设为外部供应
  saveSettings();
  renderSpec();
  $('pick-dialog').close();
  setStatus('');
  openExt();
});
document.querySelectorAll('[data-page]').forEach((b) =>
  b.addEventListener('click', () => {
    state.page = Number(b.dataset.page);
    document.querySelectorAll('[data-page]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    saveSettings();
    renderCatalog();
  }),
);
$('find').addEventListener('input', renderCatalog);
function openPicker(mode) {
  pickMode = mode;
  $('pick-title').textContent = mode.add ? '添加目标产物' : '更换目标产物';
  $('pick-msg').textContent = '';
  renderCatalog();
  $('pick-dialog').showModal();
  $('find').focus();
}
$('goal-add').addEventListener('click', () => openPicker({ add: true }));
$('goals').addEventListener('click', (e) => {
  const pick = e.target.closest('.target-btn[data-i]');
  if (pick) return openPicker({ index: Number(pick.dataset.i) });
  const rm = e.target.closest('.rm[data-i]');
  if (rm && state.targets.length > 1) {
    readOptions();
    state.targets.splice(Number(rm.dataset.i), 1);
    saveSettings();
    renderSpec();
  }
});
$('goals').addEventListener('change', () => {
  readOptions();
  saveSettings();
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- 外部供应（弹窗） ----------
function requestChain() {
  if (!state.targets.every((t) => byId.get(t.id))) return;
  readOptions();
  send({ type: 'chain', id: ++chainId, params: { targets: state.targets.map((t) => ({ target: t.id, rate: t.rate > 0 ? t.rate : 60 })), raw: [...state.ext], recipes: { ...state.recipes }, lab: state.lab, labStack: state.labstack } });
}
function openExt() {
  $('tiers').innerHTML = '<p class="hint">正在列出中间产物…</p>';
  $('ext-foot').textContent = '';
  if (!$('ext-dialog').open) $('ext-dialog').showModal();
  requestChain();
}
function onChain(d) {
  if (autoSuggest) {
    autoSuggest = false;
    const add = d.suggested.filter((n) => !state.ext.has(n));
    if (add.length) {
      add.forEach((n) => state.ext.add(n));
      saveSettings();
      renderSpec();
      requestChain();
      return;
    }
  }
  // 带过来的方案把每个物品选的配方都带来了：和默认一样的、只有一种配方的去掉，只留真正换过的（不然都显示成「新配方」）
  if (handoff && !handoff.pruned) {
    handoff.pruned = true;
    const choices = new Map(d.recipes.map((r) => [r.id, r]));
    for (const k of Object.keys(state.recipes)) if (!choices.has(Number(k)) || choices.get(Number(k)).def.id === state.recipes[k]) delete state.recipes[k];
    saveSettings();
    renderSpec();
  }
  chainData = d;
  renderExt();
  // 带过来的方案：外部供应按建议补齐后自动排一次
  if (handoff?.auto && !handoff.ran) {
    handoff.ran = true;
    $('spec').requestSubmit();
  }
}
// 依赖连线的颜色：按上游物品分配，白底上彼此可分
const LINK_COLORS = ['#2f6fb0', '#c0612b', '#2e8b6a', '#8a4fb8', '#b8862b', '#c23f6b', '#4a8f2f', '#2b8fa8', '#7a5c3a', '#5864c9'];
function renderExt() {
  const d = chainData;
  if (!d) return;
  $('ext-title').textContent = `外部供应：${d.title}`;
  const tiers = new Map([[0, d.goals]]);
  for (const u of d.units) {
    if (!tiers.has(u.depth)) tiers.set(u.depth, []);
    tiers.get(u.depth).push(u);
  }
  const names = new Map([...d.goals, ...d.units].map((u) => [u.id, u.name]));
  const usesOf = (id) => d.edges.filter((e) => e.from === id && e.state !== 'dropped').map((e) => names.get(e.to));
  const label = (k) => (k === 0 ? '最终目标' : k === 1 ? '直接原料' : `往上游第 ${k} 层`);
  const tile = (u, isGoal) => {
    const blocking = d.blocking.includes(u.name);
    const cls = ['xt', isGoal ? 'is-goal' : '', u.state === 'external' ? 'is-ext' : '', u.state === 'dropped' ? 'is-dropped' : '', blocking ? 'is-blocking' : ''].join(' ');
    const n = u.levels ? `${u.count} 叠×${u.levels} 层` : `${u.count} 台`;
    const sub = isGoal ? `出 ${fmt(u.out)}/分，${n}` : blocking ? `需要${u.factory}` : u.state === 'line' ? `${fmt(u.rate)}/分，${n}` : `${fmt(u.rate)}/分`;
    const uses = usesOf(u.id);
    const usesTxt = uses.length ? `，用于 ${uses.join('、')}` : '';
    const tip = isGoal
      ? `${u.name}：最终目标，${u.factory} ${n}${usesTxt}`
      : u.state === 'dropped'
        ? `${u.name}：上游已有外部供应，产线里不再需要它`
        : blocking
          ? `${u.name}：需要${u.factory}，目前排不了，请设为外部供应${usesTxt}`
          : u.state === 'external'
            ? `${u.name}：外部供应 ${fmt(u.rate)}/分${usesTxt}。点击改回在产线里生产`
            : `${u.name}：${u.factory} ${n}，${fmt(u.rate)}/分${usesTxt}。点击设为外部供应`;
    return `<button type="button" class="${cls}" style="--cat:${CAT_COLOR[u.type] || '#9aa5b1'}" data-id="${u.id}" data-name="${esc(u.name)}" title="${esc(tip)}" aria-pressed="${u.state === 'external'}"${u.state === 'dropped' || isGoal ? ' aria-disabled="true"' : ''}>${pic(u)}<span class="nm">${esc(u.name)}</span><span class="sub">${esc(sub)}</span></button>`;
  };
  $('tiers').innerHTML =
    '<svg class="links" aria-hidden="true"></svg>' +
    [...tiers.keys()]
      .sort((a, b) => a - b)
      .map((k) => `<section class="tier"><h3>${label(k)}</h3><div class="tier-row">${tiers.get(k).map((u) => tile(u, k === 0)).join('')}</div></section>`)
      .join('');
  const raws = d.raws.map((r) => `${esc(r.name)} ${fmt(r.rate)}/分`).join('、');
  const ext = [...state.ext];
  $('ext-foot').innerHTML = d.blocking.length
    ? `<span class="warn">${esc(d.blocking.join('、'))} 需要原油精炼厂等，产线排不了。${
        d.suggested.length ? `建议把 ${esc(d.suggested.join('、'))} 设为外部供应，点「按建议设置」即可。` : '请把它们设为外部供应。'
      }</span>`
    : `从边缘送入：${ext.length ? `${esc(ext.join('、'))}（外部供应），` : ''}${raws || '无'}。`;
  if (d.byproducts?.length) $('ext-foot').innerHTML += ` 副产：${d.byproducts.map((b) => `${esc(b.name)} ${fmt(b.rate)}/分（${esc(b.of)}）${state.burn.includes(b.id) ? '就地烧掉' : '单独一条带送出'}`).join('、')}。`;
  $('ext-foot').dataset.base = $('ext-foot').innerHTML;
  $('ext-suggest').hidden = !d.suggested.some((n) => !state.ext.has(n));
  renderRecipes(d);
  renderBurn(d);
  requestAnimationFrame(drawLinks);
}

// 多余副产物（用户 2026/10/07：烧不烧在这个弹窗里选）：每种副产物一个开关，点了就地接到一排火力发电厂烧掉，再点改回送出
function renderBurn(d) {
  const box = $('ext-burn');
  const list = (d.byproducts || []).filter((b) => b.burnable);
  box.hidden = !list.length;
  if (!list.length) return (box.innerHTML = '');
  box.innerHTML =
    '<h3>多余副产物</h3><div class="rc-row">' +
    list
      .map((b) => {
        const on = state.burn.includes(b.id);
        const tip = on ? `${b.name}：就地烧掉。点击改回单独一条带送出` : `${b.name}：现在单独一条带送出。点击改成接到一排火力发电厂就地烧掉（火力发电厂按电网要多少电来烧，电网用不完时会少烧，${b.name}会堆起来）`;
        return `<button type="button" class="rc" data-burn="${b.id}" aria-pressed="${on}" title="${esc(tip)}"><span class="rc-name">${esc(b.name)} ${fmt(b.rate)}/分：就地烧掉</span><span class="rc-line">接到一排火力发电厂（来自${esc(b.of)}），约 ${b.plants} 台</span></button>`;
      })
      .join('') +
    '</div>';
}
$('ext-burn').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-burn]');
  if (!b) return;
  const id = Number(b.dataset.burn);
  state.burn = state.burn.includes(id) ? state.burn.filter((x) => x !== id) : [...state.burn, id];
  saveSettings();
  renderSpec();
  requestChain();
});

// 新配方：产线里有新配方（高效、原始等）的物品逐个列出，点一下开启、再点一下关掉
function renderRecipes(d) {
  const box = $('ext-recipes');
  const list = d.recipes || [];
  box.hidden = !list.length;
  if (!list.length) return (box.innerHTML = '');
  box.innerHTML =
    '<h3>新配方</h3><div class="rc-row">' +
    list
      .flatMap((x) =>
        x.alts.map((a) => {
          const on = x.chosen === a.id;
          const tip = on ? `${x.name}：正在用「${a.name}」（${a.line}）。点击改回「${x.def.name}」（${x.def.line}）` : `${x.name}：现在用「${x.def.name}」（${x.def.line}）。点击改用「${a.name}」（${a.line}）`;
          return `<button type="button" class="rc" data-item="${x.id}" data-recipe="${a.id}" aria-pressed="${on}" title="${esc(tip)}"><span class="rc-name">${esc(a.name)}</span><span class="rc-line">${esc(a.line)}</span></button>`;
        }),
      )
      .join('') +
    '</div>';
}
$('ext-recipes').addEventListener('click', (e) => {
  const b = e.target.closest('button.rc');
  if (!b) return;
  const item = b.dataset.item;
  const r = Number(b.dataset.recipe);
  if (Number(state.recipes[item]) === r) delete state.recipes[item];
  else state.recipes[item] = r;
  saveSettings();
  renderSpec();
  requestChain();
});

/**
 * 依赖连线：每条边从上游方块的上沿连到消费者方块的下沿（消费者在上面一层或更上面）。
 * 同一个上游有几个消费者时，起点在上沿均匀散开，按消费者的左右顺序排，线就不会在起点交叉；
 * 同一个消费者有几个上游时，终点在下沿同样散开。线宽按流量的平方根。
 */
function drawLinks() {
  const d = chainData;
  const box = $('tiers');
  const svg = box?.querySelector('svg.links');
  if (!d || !svg) return;
  const base = box.getBoundingClientRect();
  const rect = new Map();
  box.querySelectorAll('.xt[data-id]').forEach((el) => {
    const r = el.getBoundingClientRect();
    rect.set(Number(el.dataset.id), { x: r.left - base.left + box.scrollLeft, y: r.top - base.top + box.scrollTop, w: r.width, h: r.height });
  });
  svg.setAttribute('width', box.scrollWidth);
  svg.setAttribute('height', box.scrollHeight);
  const edges = d.edges.filter((e) => rect.has(e.from) && rect.has(e.to));
  const cx = (id) => rect.get(id).x + rect.get(id).w / 2;
  // 起点、终点在方块边上散开的位置
  const slot = new Map();
  const spread = (key, list, id, sortKey) => {
    list.sort((a, b) => sortKey(a) - sortKey(b));
    const r = rect.get(id);
    list.forEach((e, i) => slot.set(`${key}|${e.from}>${e.to}`, r.x + r.w * ((i + 1) / (list.length + 1))));
  };
  const outs = new Map();
  const ins = new Map();
  for (const e of edges) {
    (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e);
    (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e);
  }
  for (const [id, list] of outs) spread('o', list, id, (e) => cx(e.to));
  for (const [id, list] of ins) spread('i', list, id, (e) => cx(e.from));
  const color = new Map();
  [...outs.keys()].forEach((id, i) => color.set(id, LINK_COLORS[i % LINK_COLORS.length]));
  const max = Math.max(1, ...edges.map((e) => e.rate));
  svg.innerHTML = edges
    .map((e) => {
      const a = rect.get(e.from);
      const b = rect.get(e.to);
      const x1 = slot.get(`o|${e.from}>${e.to}`);
      const x2 = slot.get(`i|${e.from}>${e.to}`);
      const y1 = a.y;
      let path;
      if (Math.abs(a.y - b.y) < 4) {
        // 同一层（一个目标又是另一个目标的原料）：从上沿拱过去
        const y = a.y - 14;
        path = `M${x1} ${y1}C${x1} ${y} ${x2} ${y} ${x2} ${b.y}`;
      } else {
        const y2 = b.y + b.h;
        const dy = Math.max(16, (y1 - y2) / 2);
        path = `M${x1} ${y1}C${x1} ${y1 - dy} ${x2} ${y2 + dy} ${x2} ${y2}`;
      }
      const w = (1.2 + 3.2 * Math.sqrt(e.rate / max)).toFixed(2);
      return `<path class="lk st-${e.state}" data-from="${e.from}" data-to="${e.to}" d="${path}" stroke="${color.get(e.from)}" stroke-width="${w}"/>`;
    })
    .join('');
}
// 悬停或聚焦某个产物：只亮它直接相连的线和产物，底部列出它供给谁、由谁供给
function focusLinks(id) {
  const d = chainData;
  const box = $('tiers');
  if (!d || !box) return;
  box.classList.toggle('has-focus', id != null);
  box.querySelectorAll('.lk').forEach((p) => p.classList.toggle('on', id != null && (Number(p.dataset.from) === id || Number(p.dataset.to) === id)));
  const near = new Set(id == null ? [] : [id, ...d.edges.filter((e) => e.from === id).map((e) => e.to), ...d.edges.filter((e) => e.to === id).map((e) => e.from)]);
  box.querySelectorAll('.xt[data-id]').forEach((el) => el.classList.toggle('near', near.has(Number(el.dataset.id))));
  const foot = $('ext-foot');
  if (id == null) {
    foot.innerHTML = foot.dataset.base || '';
    return;
  }
  const names = new Map([...d.goals, ...d.units].map((u) => [u.id, u.name]));
  const live = (e) => e.state !== 'dropped';
  const down = d.edges.filter((e) => e.from === id && live(e)).map((e) => `${esc(names.get(e.to))} ${fmt(e.rate)}/分`);
  const up = d.edges.filter((e) => e.to === id && live(e)).map((e) => esc(names.get(e.from)));
  foot.innerHTML = `<b>${esc(names.get(id))}</b>${down.length ? ` → ${down.join('、')}` : ''}${up.length ? `；原料来自 ${up.join('、')}` : ''}`;
}
for (const ev of ['mouseover', 'focusin']) $('tiers').addEventListener(ev, (e) => focusLinks(e.target.closest('.xt[data-id]') ? Number(e.target.closest('.xt[data-id]').dataset.id) : null));
$('tiers').addEventListener('mouseleave', () => focusLinks(null));
if (typeof ResizeObserver === 'function') new ResizeObserver(() => requestAnimationFrame(drawLinks)).observe($('tiers'));
$('tiers').addEventListener('click', (e) => {
  const b = e.target.closest('.xt');
  if (!b || b.classList.contains('is-dropped') || b.classList.contains('is-goal')) return;
  const name = b.dataset.name;
  if (state.ext.has(name)) state.ext.delete(name);
  else state.ext.add(name);
  $('suggest').hidden = true;
  saveSettings();
  renderSpec();
  requestChain();
});
$('ext-suggest').addEventListener('click', () => {
  if (!chainData) return;
  chainData.suggested.forEach((n) => state.ext.add(n));
  saveSettings();
  renderSpec();
  requestChain();
});
$('ext-done').addEventListener('click', () => $('ext-dialog').close());
$('ext-edit').addEventListener('click', () => {
  if (!state.targets.every((t) => byId.get(t.id))) {
    setStatus('先选目标产物。', true);
    return;
  }
  openExt();
});

function renderSpec() {
  const many = state.targets.length > 1;
  $('goals').innerHTML = state.targets
    .map((t, i) => {
      const it = byId.get(t.id);
      const name = it ? it.name : '还没选';
      return `<li class="goal">
        <button type="button" class="target-btn" data-i="${i}" aria-haspopup="dialog" aria-label="更换目标 ${esc(name)}">
          <span class="tile is-target" style="--cat:${it ? CAT_COLOR[it.type] || '#9aa5b1' : '#9aa5b1'}">${it ? pic(it) : '<span class="nm">—</span>'}</span>
          <span><span class="pick-name">${esc(name)}</span><span class="tb-hint">点击更换</span></span>
        </button>
        <input type="number" min="1" step="1" inputmode="numeric" data-i="${i}" value="${t.rate}" aria-label="${esc(name)} 每分钟产量">
        <button type="button" class="rm" data-i="${i}" aria-label="移除目标 ${esc(name)}"${many ? '' : ' hidden'}>×</button>
      </li>`;
    })
    .join('');
  const ext = [...state.ext];
  // 开了新配方的物品也列在这里（在弹窗底部开关）
  const alts = Object.keys(state.recipes)
    .map((id) => byId.get(Number(id)))
    .filter(Boolean)
    .map((x) => `<li class="rc-on">${pic(x)}${esc(x.name)}：新配方<button type="button" data-recipe-off="${x.id}" aria-label="${esc(x.name)} 改回默认配方">×</button></li>`)
    .concat(state.burn.map((id) => byId.get(id)).filter(Boolean).map((x) => `<li class="rc-on">${pic(x)}${esc(x.name)}：就地烧掉<button type="button" data-burn-off="${x.id}" aria-label="${esc(x.name)} 改回送出">×</button></li>`));
  $('ext-list').innerHTML =
    ext.length || alts.length
      ? ext
          .map((n) => {
            const x = catalog.find((c) => c.name === n);
            return `<li>${x ? pic(x) : ''}${esc(n)}<button type="button" data-ext="${esc(n)}" aria-label="移除外部供应 ${esc(n)}">×</button></li>`;
          })
          .concat(alts)
          .join('')
      : '<li class="none">无</li>';
  if (!state.splitPicked) {
    state.split = state.targets.length > 1 ? '1' : '0';
    const el = document.querySelector(`input[name="split"][value="${state.split}"]`);
    if (el) el.checked = true;
    syncOptionSelects();
  }
  toggleStitch();
  renderMore();
}
// 「切分后的蓝图」只在开了自动切分时有意义；自己点过「自动切分」以后就不再跟着目标个数变
function toggleStitch() {
  $('stitch-field').hidden = document.querySelector('input[name="split"]:checked')?.value !== '1';
}
document.querySelectorAll('input[name="split"]').forEach((el) => el.addEventListener('change', () => {
  state.splitPicked = true;
  readOptions();
  saveSettings();
  toggleStitch();
}));
// 折叠起来的「布局细节」在标题上显示当前取值
function renderMore() {
  const pick = (name) => document.querySelector(`input[name="${name}"]:checked`)?.nextElementSibling?.textContent ?? '';
  const aspect = pick('aspect');
  const mw = pick('maxwidth');
  const mh = pick('maxheight');
  $('more-now').textContent = `宽度${mw === '不限' ? '不限' : `≤${mw}`}，长度${mh === '不限' || !mh ? '不限' : `≤${mh}`}，长宽比${aspect === '不限' ? '不限' : ` ${aspect}`}`;
  const connected = !!document.querySelector('input[name="station"]:checked')?.value;
  $('stack-now').textContent = connected ? `物流站出货叠 ${pick('pile')} 层` : '';
  $('slots-now').textContent = `增产剂格${pick('proslot')}，翘曲器格${pick('warper') === '不放' ? '不放' : '整张一格'}`;
  const a = pick('assembler');
  $('equip-now').textContent = `${a === '重组式' ? '重组式' : `${a} `}制造台，${pick('smelter')}熔炉，${pick('chemical')}${document.querySelector('input[name="chemtight"]:checked')?.value === '1' ? '（赤道压缩）' : ''}，${pick('lab')}研究站叠 ${labStackOf($('labstack').value)} 层，${pick('belt')}带，${pick('sorter')}分拣器`;
}
// 长宽比上限和宽度、长度上限容易打架：开了长宽比，宽、长回到不限；开了宽或长，长宽比回到不限
$('more').addEventListener('change', (e) => {
  const name = e.target?.name;
  const set = (n, v) => {
    const el = document.querySelector(`input[name="${n}"][value="${v}"]`);
    if (el && !el.checked) el.checked = true;
  };
  if (name === 'aspect' && e.target.value) ['maxwidth', 'maxheight'].forEach((n) => set(n, ''));
  if ((name === 'maxwidth' || name === 'maxheight') && e.target.value) set('aspect', '');
  syncOptionSelects();
  readOptions();
  saveSettings();
  renderMore();
});
$('equip').addEventListener('change', renderMore);
$('stack').addEventListener('change', renderMore);
$('station-slots').addEventListener('change', renderMore);
document.querySelectorAll('input[name="station"]').forEach((el) => el.addEventListener('change', renderMore));
$('labstack').addEventListener('change', () => {
  $('labstack').value = labStackOf($('labstack').value);
  readOptions();
  saveSettings();
  renderMore();
});
// 站输出集装只在接物流站时有意义
function togglePile() {
  const connected = !!document.querySelector('input[name="station"]:checked')?.value;
  $('pile-field').hidden = !connected;
  $('stack').hidden = !connected; // 「集装」一组只剩物流站出货叠层（产物送走前叠层用户 2026/10/07 说没用、去掉了）
  $('station-slots').hidden = !connected; // 物流站格子也只在接物流站时有意义
  const select = $('pile-field').querySelector('select');
  if (select) {
    select.disabled = !connected;
    select.title = connected ? '物流站输出堆叠层数，取决于已解锁科技' : '接入物流站后可设置';
  }
}
document.querySelectorAll('input[name="station"]').forEach((el) => el.addEventListener('change', togglePile));
$('ext-list').addEventListener('click', (e) => {
  const burnOff = e.target.closest('button[data-burn-off]');
  if (burnOff) {
    state.burn = state.burn.filter((x) => x !== Number(burnOff.dataset.burnOff));
    saveSettings();
    renderSpec();
    return;
  }
  const off = e.target.closest('button[data-recipe-off]');
  if (off) {
    delete state.recipes[off.dataset.recipeOff];
    saveSettings();
    renderSpec();
    return;
  }
  const b = e.target.closest('button[data-ext]');
  if (!b) return;
  state.ext.delete(b.dataset.ext);
  saveSettings();
  renderSpec();
});

// ---------- 生成 ----------
function setStatus(text, isErr = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', isErr);
}
let timer = null;
let progress = null; // 后台报来的进度：{ est: 估算秒数, search: [完成, 总数], finish: [完成, 总数] }
function setBusy(on) {
  busy = on;
  $('go').disabled = on;
  $('go').textContent = on ? '正在排布…' : '生成蓝图';
  clearInterval(timer);
  $('progress').hidden = !on;
  $('progress').classList.remove('slow');
  $('progress-bar').style.width = '0';
  resetPreview();
  if (on) {
    progress = null;
    const t0 = performance.now();
    timer = setInterval(() => {
      const used = (performance.now() - t0) / 1000;
      if (!progress?.est0) {
        setStatus(`正在排布，已用 ${used.toFixed(1)} 秒`);
        return;
      }
      // 预计就是开搜前报的那个数，中途不改；过了预计进度条停在 99%，只提示比预计久
      const est = Math.ceil(progress.est0);
      const stage = progress.finish?.[1] ? 0.85 + 0.1 * (progress.finish[0] / progress.finish[1]) : progress.search?.[1] ? 0.85 * (progress.search[0] / progress.search[1]) : 0;
      const frac = Math.max(used / est, stage);
      $('progress-bar').style.width = `${Math.min(99, frac * 100).toFixed(1)}%`;
      const slow = used > est;
      $('progress').classList.toggle('slow', slow);
      const best = progress.round && progress.best != null && progress.feasible ? ` · 目前最好 ${Math.round(progress.best * 100)}%` : '';
      setStatus(slow ? `比预计（约 ${est} 秒）久，还在算，已用 ${used.toFixed(0)} 秒${best}` : `正在排布：预计约 ${est} 秒，已用 ${used.toFixed(1)} 秒${best}`);
    }, 100);
  }
}

// ---------- 实时预览（观摩退火） ----------
// 搜索时后台每半秒报一次各轮的进度，正在看的那一轮每秒最多一份当前排法的绘图模型
// （搜索阶段只有生产区，物流站、供电在后处理才放）。图纸区画排法，可以切换看哪一轮，默认「自动」：看利用率最高的那一轮，不频繁切换（后台 autowatch.js 挑）。
// 步数、温度、代价这些数字不显示（用户 2026/10/07：多余，不要乱）
let preview = null;
function resetPreview() {
  preview = null;
  $('preview').hidden = true;
  $('preview-tabs').innerHTML = '';
  $('preview-note').textContent = '搜索中，看第几轮';
  $('take').disabled = true;
  $('take').textContent = '就这个蓝图了';
}
// 就这个蓝图了（用户 2026/10/07）：把图纸区正在画的这一张交给后台收尾出图，结束这次搜索
$('take').addEventListener('click', () => {
  if (!busy || !preview?.drawnModel) return;
  $('take').disabled = true;
  $('take').textContent = '正在收尾…';
  $('preview-note').textContent = '正在把这一张收尾出图';
  send({ type: 'take', id: reqId });
});
function onPreview(m) {
  if (!busy) return; // 结果已经出了，迟到的快照不要
  if (!preview) preview = { gen: 0, rounds: new Map(), watch: 'auto', model: null, modelRound: null, drawnModel: null, painted: 0, userMoved: false };
  if (m.gen !== preview.gen) {
    // 没达标接着搜：新一段搜索，上一段的轮次清掉
    preview.gen = m.gen;
    preview.rounds.clear();
    preview.model = null;
    preview.modelRound = null;
  }
  preview.rounds.set(m.round, { best: m.best });
  if (m.model) {
    preview.model = m.model;
    preview.modelRound = m.round;
  }
  renderPreview(!!m.model);
}
/** 正在看哪一轮：自动模式看最近画过的那轮（后台挑的利用率最高、不频繁切换的那轮），还没有就挑代价最好的 */
// 预览时用户自己拖动、滚轮缩放过图纸，之后就保持他的视角（不再每张重新适配）
['pointerdown', 'wheel'].forEach((ev) => $('drawing').addEventListener(ev, () => {
  if (preview) preview.userMoved = true;
}, { passive: true }));
function previewRound() {
  if (preview.watch !== 'auto') return preview.watch;
  if (preview.modelRound != null) return preview.modelRound;
  let pick = null;
  for (const [s, r] of preview.rounds) if (pick == null || r.best < preview.rounds.get(pick).best) pick = s;
  return pick;
}
function renderPreview(force) {
  const now = performance.now();
  if (!force && now - preview.painted < 500) return; // 十几轮一起报，攒半秒画一次就够了
  preview.painted = now;
  $('preview').hidden = false;
  const sel = previewRound();
  const rounds = [...preview.rounds.keys()].sort((a, b) => a - b);
  $('preview-tabs').innerHTML =
    `<button type="button" data-round="auto" aria-pressed="${preview.watch === 'auto'}" title="看最好的那一轮">自动</button>` +
    rounds.map((s) => `<button type="button" data-round="${s}" aria-pressed="${preview.watch === s}" title="看第 ${s + 1} 轮退火">${s + 1}</button>`).join('');
  // 还没有能看的图（后台不给长宽比离谱、超出宽长上限的排法，大产线刚开始常是一长条）：写一句，免得以为卡住了
  if (!preview.drawnModel && !preview.waiting) {
    preview.waiting = true;
    viewer.reset();
    $('drawing').innerHTML = '<div class="empty"><strong>搜索中</strong></div>';
  }
  if (!preview.rounds.has(sel)) return;
  // 图纸区画正在看那一轮的当前排法（后台约 25 秒给一张；别的轮只报数字，图保持上一张）
  if (preview.model && preview.modelRound === sel && preview.model !== preview.drawnModel) {
    preview.drawnModel = preview.model;
    const box = $('drawing');
    box.classList.add('has-svg');
    box.innerHTML = drawingSvg(preview.model, sliceRoutes(preview.model.routes), { level: 'all', id: 'preview', label: `搜索中 · 第 ${sel + 1} 轮的当前排法` });
    if ($('take').textContent === '就这个蓝图了') $('take').disabled = false;
    // 退火时排法的宽长一直在变（刚开始常是一长条），沿用上一张的取景会跑到图外面去：没拖动、没缩放过就每张都重新适配全图
    viewer.attach(box.querySelector('svg'), !preview.userMoved);
    $('floor-name').textContent = '搜索中';
    $('floor-description').textContent = `第 ${sel + 1} 轮`;
    $('floor-meta').textContent = `${preview.model.width} × ${preview.model.height} 格`;
  }
}
$('preview-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-round]');
  if (!b || !preview) return;
  preview.watch = b.dataset.round === 'auto' ? 'auto' : Number(b.dataset.round);
  // 告诉后台只转发这一轮的绘图模型（别的轮只发数字，省得每秒几百 KB 白传）
  send({ type: 'watch', id: reqId, round: preview.watch === 'auto' ? null : preview.watch });
  renderPreview(true);
});

$('spec').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  readOptions();
  $('suggest').hidden = true;
  if (!state.targets.every((t) => byId.get(t.id))) {
    setStatus(catalog.length ? '先点左上角选一个目标产物。' : '物品列表还在加载，稍等一秒再点。', true);
    return;
  }
  const badRate = state.targets.findIndex((t) => !(t.rate > 0));
  if (badRate >= 0) {
    setStatus('每分钟产量需要是正数。', true);
    document.querySelector(`#goals input[data-i="${badRate}"]`)?.focus();
    return;
  }
  saveSettings();
  const params = { targets: state.targets.map((t) => ({ target: t.id, rate: t.rate })), raw: [...state.ext], recipes: { ...state.recipes } };
  for (const name of OPTION_NAMES) params[name] = state[name];
  params.orient = 'h';
  params.labstack = state.labstack;
  params.burn = state.burn.slice(); // 要就地烧掉的副产物（真实物品编号）
  $('labstack').value = state.labstack;
  setBusy(true);
  reqId++;
  send({ type: 'plan', id: reqId, params });
});

$('suggest').addEventListener('click', () => {
  state.ext.add($('suggest').dataset.item);
  saveSettings();
  renderSpec();
  $('spec').requestSubmit();
});

// ---------- 结果 ----------
function finish(d) {
  setBusy(false);
  if (d.error) {
    setStatus(d.error, true);
    if (d.suggestRaw) {
      $('suggest').hidden = false;
      $('suggest').dataset.item = d.suggestRaw;
      $('suggest').textContent = `把「${d.suggestRaw}」改为外部供应，再生成一次`;
    }
    return;
  }
  if (d.modules) {
    split = d;
    // 拼接成一张时先看整张，分开生成时先看第 1 块
    renderModuleTabs(d.stitched ? -1 : 0);
    if (d.stitched) showStitched();
    else show(d.modules[0]);
    goalNote(d.goal);
    return;
  }
  split = null;
  $('module-tabs').hidden = true;
  show(d);
  goalNote(d.goal, d.picked);
}

/**
 * 没达到这一档的利用率（用户 2026/10/07 改：照常显示搜到的最好那张）：状态栏后面补一句。
 * 连续几段没进步就先停了（stalled，同日用户要的「没进展就停」），不然是到了时间上限。不可行、检查没过 show 已经说了
 */
function goalNote(g, picked = null) {
  if (picked || !g || g.met || g.space >= g.target) return;
  if (g.feasible) console.info(`[dsp-handcraft] 利用率 ${Math.round(g.space * 100)}%，没到这一档的 ${Math.round(g.target * 100)}%${g.stalled ? '（连续几段没进步，先停了）' : ''}`);
}

/** 切成几块时，图纸上方一排标签，一块一个；点哪块看哪块。拼接成一张时最前面多一个「整张」（k = −1） */
function renderModuleTabs(k) {
  const tabs = $('module-tabs');
  tabs.hidden = false;
  const st = split.stitched;
  tabs.innerHTML = (st ? `<button type="button" role="tab" data-module="-1" aria-selected="${k === -1}">整张<small class="${st.check.ok ? 'ok' : 'warn'}">${st.width}×${st.height}${st.check.ok ? '' : ' · 需注意'}</small></button>` : '') + split.modules
    .map((m, i) => {
      const ok = m.feasible && m.check.ok;
      return `<button type="button" role="tab" data-module="${i}" aria-selected="${i === k}"><span class="num">${i + 1}</span> ${esc(m.module.name)}<small class="${ok ? 'ok' : 'warn'}">${m.metrics.width}×${m.metrics.height}${ok ? '' : ' · 需注意'}</small></button>`;
    })
    .join('');
}
$('module-tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-module]');
  if (!b || !split) return;
  const k = Number(b.dataset.module);
  renderModuleTabs(k);
  if (k < 0) showStitched();
  else show(split.modules[k]);
});

/** 状态栏：切了几块、哪几块要注意 */
function splitStatus() {
  const secs = (split.ms / 1000).toFixed(1);
  const bad = split.modules.map((m, i) => (m.feasible && m.check.ok ? null : i + 1)).filter(Boolean);
  setStatus(`完成，用时 ${secs} 秒，切成了 ${split.modules.length} 块${bad.length ? `，第 ${bad.join('、')} 块需注意` : ''}。`, bad.length > 0 || (split.stitched && !split.stitched.check.ok));
}

/** 整张拼接图：各块的图按拼接时的位置摆在一起（y 向上，和蓝图一致），左上角标块号 */
function stitchedSvg() {
  const st = split.stitched;
  const TW = st.width;
  const TH = st.height;
  const parts = [`<rect x="-3" y="-4" width="${TW + 6}" height="${TH + 7}" fill="#112f52"/>`];
  split.modules.forEach((m, k) => {
    const o = st.offsets[k];
    const W = m.metrics.width;
    const H = m.metrics.height;
    const x = o.x;
    const y = TH - o.y - H;
    const svg = drawingSvg(m.model, sliceRoutes(m.model.routes), { level: 'all', buildings: view.buildings, sorters: view.sorters, power: view.power, id: `m${k}`, label: m.module.name });
    parts.push(svg.replace(/^<svg [^>]*>/, `<svg x="${x - 2}" y="${y - 2.3}" width="${W + 4.3}" height="${H + 4.3}" viewBox="-2 -2.3 ${W + 4.3} ${H + 4.3}">`));
    const label = `${k + 1}. ${m.module.name}`;
    parts.push(`<rect x="${x + 0.3}" y="${y + 0.3}" width="${Math.min(W - 0.6, label.length * 1.25 + 1)}" height="2" rx="0.3" fill="rgba(12,35,64,0.85)"/><text x="${x + 0.8}" y="${y + 1.32}" font-size="1.3" fill="#ffffff" font-weight="700" dominant-baseline="central" font-family="system-ui, sans-serif">${esc(label)}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -4 ${TW + 6} ${TH + 7}" role="group" aria-label="整张拼接图，${TW} 乘 ${TH} 格">${parts.join('')}</svg>`;
}

/** 看整张拼接图：楼层导航、图纸数据只对单块有意义，先收起来 */
function showStitched() {
  const st = split.stitched;
  last = null;
  floors = [];
  $('layer-controls').hidden = true;
  $('layer-rail').hidden = true;
  $('result-details').hidden = true;
  $('sheet-tools').querySelectorAll('button').forEach((b) => (b.disabled = false));
  splitStatus();
  $('sheet-name').textContent = `整张（${split.modules.length} 块拼接）`;
  const sum = split.modules.reduce((n, m) => n + m.metrics.area, 0);
  $('sheet-stats').hidden = false;
  $('sheet-stats').innerHTML =
    `<span><b>${st.width}×${st.height}</b>格</span>` +
    `<span>各块合计<b>${sum}</b>格</span>` +
    `<span>物流站<b>${st.stations}</b></span>` +
    (st.check.ok ? '<span class="ok">检查通过</span>' : `<span class="warn">需注意 ${st.check.errors.length} 处</span>`);
  const bad = split.modules.filter((m) => !m.feasible);
  $('sheet-alert').hidden = !bad.length;
  if (bad.length) $('sheet-alert').innerHTML = `<strong>有 ${bad.length} 块不可行。</strong>点上方那一块的标签看原因；可以把「搜索力度」调高一档再试。`;
  $('floor-name').textContent = '整张';
  $('floor-description').textContent = `${split.modules.length} 块各自的总览（实线地面 · 虚线高架）`;
  $('floor-meta').textContent = `${st.width} × ${st.height} 格`;
  const box = $('drawing');
  box.classList.add('has-svg');
  box.innerHTML = stitchedSvg();
  viewer.reset();
  viewer.attach(box.querySelector('svg'));
  const li = ['<li>各块之间靠物流运输机送货，每座物流站里放上运输机。</li>'];
  if (st.energyText) li.push(`<li>整张${esc(st.energyText)}。</li>`);
  if (st.check.ok) li.push('<li class="ok">检查通过。</li>');
  for (const e of st.check.errors) li.push(`<li class="err">${esc(e)}</li>`);
  for (const w of st.check.warnings) li.push(`<li>${esc(w)}</li>`);
  $('notes').innerHTML = li.join('');
  $('ports').innerHTML = split.modules
    .map((m, k) => `<li>第 ${k + 1} 块 ${esc(m.module.name)}：产出 ${m.module.makes.map((t) => `${esc(t.name)} ${fmt(t.rate)}/分`).join('、')}；要运来 ${m.module.needs.map(esc).join('、') || '无'}。</li>`)
    .join('');
  $('bp').value = st.blueprint;
  $('copy').disabled = false;
  $('copy').textContent = '复制蓝图';
  $('copy-top').hidden = false;
  $('copy-top').textContent = '复制蓝图';
  $('bp-meta').textContent = `${st.blueprint.length.toLocaleString()} 字符（${split.modules.length} 块拼成一张）`;
}

/** 把一张图的结果画出来（切块时是当前那块） */
function show(d) {
  last = d;
  floors = sliceRoutes(d.model.routes);
  view.level = 0;
  view.focus = '';
  view.selected = '';
  viewer.reset();
  renderFloorNav(d);
  const secs = (d.ms / 1000).toFixed(1);
  if (d.threads > 1) console.info(`[dsp-handcraft] 用时 ${secs} 秒，${d.threads} 个线程`);
  if (split) splitStatus();
  else setStatus(d.feasible && d.check.ok ? `完成，用时 ${secs} 秒。` : `已生成，但有需要注意的地方（见下面「检查」），用时 ${secs} 秒。`, !(d.feasible && d.check.ok));
  $('sheet-name').textContent = d.module ? `${d.module.k + 1}. ${d.module.name}` : d.title ?? `${d.target} ${fmt(d.rate)}/分`;
  fillAlert(d);
  drawSheet(d);
  fillLegend(d);
  fillTitleBlock(d);
  fillPorts(d);
  fillNotes(d);
  fillSheetStats(d);
  $('bp').value = d.blueprint;
  $('copy').disabled = false;
  $('copy').textContent = '复制蓝图';
  $('copy-top').hidden = false;
  $('copy-top').textContent = '复制蓝图';
  $('bp-meta').textContent = `${d.blueprint.length.toLocaleString()} 字符`;
}

/** 图纸上方的红条：这张图不可行时醒目地说出来，并说怎么办 */
function fillAlert(d) {
  const box = $('sheet-alert');
  if (d.array || d.feasible) {
    box.hidden = true;
    return;
  }
  const why = d.penalties.find((x) => x.kind !== 'power')?.msg ?? d.penalties[0]?.msg ?? d.validate.errors[0] ?? '';
  const tip = d.module
    ? '这一块还是排不下：把「搜索力度」调高一档再试。'
    : d.metrics.factories > 120 || d.metrics.stationFallback
      ? '产线太大，一块排不下：在「外部供应」里把被多处使用的中间产物（比如电路板、处理器）设为外部供应，拆成几块分别生成；或者把「搜索力度」调高一档。'
      : '把「搜索力度」调高一档再试；还不行就在「外部供应」里拆出一部分。';
  box.hidden = false;
  box.innerHTML = `<strong>这张图不可行，贴进游戏会有断带或接不上的地方。</strong>${why ? `${esc(why)}。` : ''}${tip}`;
}

const fmt = (n) => (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(1));
const colorOf = (d, itemId) => routeColor(d.model, itemId);

/** 画布标题栏：尺寸、利用率、带数、检查结果，生成完一眼看到 */
function fillSheetStats(d) {
  const m = d.metrics;
  const ok = d.feasible && d.check.ok;
  const issues = d.check.errors.length + (d.penalties?.length || 0) + d.validate.errors.length;
  $('sheet-stats').hidden = false;
  $('sheet-stats').innerHTML =
    `<span><b>${m.width}×${m.height}</b>格</span>` +
    `<span>利用率<b>${Math.round((m.space?.space ?? 0) * 100)}%</b></span>` +
    `<span>传送带<b>${m.belts}</b></span>` +
    (ok ? '<span class="ok">检查通过</span>' : `<span class="warn" role="button" tabindex="0" title="看下面的「检查」">需注意 ${issues || ''} 处</span>`);
}
/** 图纸右下角标题栏的内容：第一行是图名，其余是图纸参数 */

function renderFloorNav(d) {
  $('layer-controls').hidden = false;
  $('layer-rail').hidden = false;
  $('sheet-foot').hidden = false;
  $('result-details').hidden = false;
  $('sheet-tools').querySelectorAll('button').forEach((b) => b.disabled = false);
  const cards = [{ z: 'all', name: '总览' }, ...floors.map((f) => ({ z: f.z, name: `L${f.z + 1}` }))];
  $('floor-list').innerHTML = cards.map((f) => {
    const count = f.z === 'all' ? floors.reduce((n, l) => n + l.cells.size, 0) : floors[f.z].cells.size;
    return `<button type="button" class="floor-card" data-floor="${f.z}" aria-pressed="${f.z === view.level}" aria-label="${f.name}，${count} 个带格"><span class="floor-info"><strong>${f.name}</strong><small>${count ? `${count} 格` : '空'}</small></span><span class="floor-thumb">${drawingSvg(d.model, floors, { level: f.z, mini: true, id: `floor-${f.z}` })}</span></button>`;
  }).join('');
}

function drawSheet(d) {
  const box = $('drawing');
  box.classList.add('has-svg');
  const all = view.level === 'all';
  const shown = all ? floors : [floors[view.level]];
  const count = shown.reduce((n, f) => n + f.cells.size, 0);
  const name = all ? '总览' : `L${view.level + 1}`;
  $('floor-name').textContent = name;
  $('floor-description').textContent = all ? '实线地面 · 虚线高架' : `${view.level === 0 ? '地面' : '高架'} · z=${view.level}`;
  $('floor-meta').textContent = `${d.model.rotated ? d.model.height : d.model.width} × ${d.model.rotated ? d.model.width : d.model.height} 格 · ${count} 带格`;
  box.innerHTML = drawingSvg(d.model, floors, { ...view, label: `${d.title ?? d.target} · ${name} 布线图` });
  document.querySelectorAll('[data-floor]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.floor === String(view.level))));
  viewer.attach(box.querySelector('svg'));
  showRouteInfo();
}

function applyZoom() {
  viewer.refresh();
}
window.addEventListener('resize', applyZoom);
if (typeof ResizeObserver === 'function') new ResizeObserver(applyZoom).observe($('drawing'));
document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => viewer.fit()));
$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
function expandViewer(expanded) {
  $('sheet').classList.toggle('is-expanded', expanded);
  document.body.classList.toggle('viewer-expanded', expanded);
  $('expand-view').textContent = expanded ? '退出大图' : '大图';
  $('expand-view').setAttribute('aria-pressed', String(expanded));
  viewer.refresh();
}
$('expand-view').addEventListener('click', () => expandViewer(!$('sheet').classList.contains('is-expanded')));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if ($('sheet').classList.contains('is-expanded')) {
    e.preventDefault();
    e.stopPropagation();
    expandViewer(false);
    $('expand-view').focus();
  } else clearRoute();
}, true);
$('floor-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-floor]');
  if (!b || !last || busy) return; // 搜索预览期间楼层导航还是上一张图的
  view.level = b.dataset.floor === 'all' ? 'all' : Number(b.dataset.floor);
  view.selected = '';
  view.focus = '';
  drawSheet(last);
});
$('floor-list').addEventListener('keydown', (e) => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const buttons = [...$('floor-list').querySelectorAll('button')];
  const index = buttons.indexOf(e.target.closest('button'));
  if (index < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next].focus();
  buttons[next].click();
});
function selectRoute(id) {
  if (busy) return; // 搜索预览期间 floors 还是上一张图的，点线路不响应
  const [z, index] = id.split(':').map(Number);
  const run = floors[z]?.runs[index];
  if (!last || !run) return;
  view.selected = id;
  view.focus = String(run.itemId);
  drawSheet(last);
  $('drawing').focus({ preventScroll: true });
}
function clearRoute() {
  $('route-info').hidden = true;
  if (!view.selected) return;
  view.selected = '';
  view.focus = '';
  if (last && !busy) drawSheet(last); // 搜索预览期间别把上一张图画回来
}
function showRouteInfo() {
  const [z, index] = view.selected.split(':').map(Number);
  const run = view.selected && floors[z]?.runs[index];
  const info = $('route-info');
  info.hidden = !run;
  if (!run) return;
  const model = last.model;
  const item = model.items[run.itemId];
  const point = ([x, y]) => `(${x + (model.origin?.x ?? 0)}, ${y + (model.origin?.y ?? 0)})`;
  const sources = [...new Set(model.sorters.filter((s) => s.itemId === run.itemId && s.io === 'out').map((s) => s.factoryItem).filter(Boolean))];
  const consumers = [...new Set(model.sorters.filter((s) => s.itemId === run.itemId && s.io === 'in').map((s) => s.factoryItem).filter(Boolean))];
  const line = (label, value) => `<dt>${label}</dt><dd>${esc(value)}</dd>`;
  const vias = floors[z].vias.filter((v) => v.itemId === run.itemId && run.cells.some(([x, y]) => x === v.x && y === v.y));
  const nextLevels = [...new Set(vias.map((v) => `L${v.to + 1}`))];
  $('route-title').textContent = item.name;
  info.style.setProperty('--route-color', routeColor(model, run.itemId));
  $('route-body').innerHTML = line('当前线段', `L${z + 1} · ${run.cells.length} 格${nextLevels.length ? ` · 接 ${nextLevels.join('、')}` : ''}`)
    + line('输送方向', `${point(run.cells[0])} → ${point(run.cells.at(-1))}`)
    + line('产线总量', `${fmt(item.rate)}/分`)
    + line('物料来源', sources.length ? sources.map((name) => `${name}产线`).join('、') : model.stations.length ? '物流站输入' : '外部输入')
    + line('用于生产', consumers.length ? consumers.join('、') : '成品送出');
}
$('close-route').addEventListener('click', clearRoute);
$('layer-controls').addEventListener('change', (e) => {
  if (!e.target.dataset.overlay || !last || busy) return;
  view[e.target.dataset.overlay] = e.target.checked;
  drawSheet(last);
});

function fillLegend(d) {
  $('legend').innerHTML = Object.entries(d.model.items).map(([id, it]) => `<li><span class="sw" style="background:${colorOf(d, id)}"></span><span>${esc(it.name)}</span><span class="legend-rate">${fmt(it.rate)}<small>/分</small></span></li>`).join('');
  $('factory-legend').innerHTML = d.groups.map((g) => `<span><b>${g.letter}</b>${esc(g.item)} <small>×${g.count}${g.levels > 1 ? ` 叠×${g.levels} 层` : ''}</small></span>`).join('');
}

function fillTitleBlock(d) {
  const m = d.metrics;
  const top = floors.filter((f) => f.cells.size).at(-1)?.z ?? 0;
  $('titleblock').hidden = false;
  $('titleblock').innerHTML = `
    <caption>DRAWING DATA / 图纸参数</caption>
    <tr><th>产线</th><td class="wide" colspan="3">${esc(d.title ?? `${d.target} ${fmt(d.rate)}/分`)}</td></tr>
    <tr><th>尺寸</th><td>${m.width} × ${m.height}</td><th>面积</th><td>${m.area}</td></tr>
    <tr><th>空间利用率</th><td>${Math.round((m.space?.space ?? 0) * 100)}%</td><th>工厂</th><td>${m.factories}</td></tr>
    <tr><th>传送带</th><td>${m.belts}</td><th>分拣器</th><td>${m.sorters}</td></tr>${
      top > 0
        ? `<tr><th>高架</th><td class="wide" colspan="3">最高 L${top + 1}</td></tr>`
        : ''
    }${
      m.power ? `<tr><th>供电</th><td class="wide" colspan="3">${esc(m.power.name)} ${m.power.count} 座</td></tr>` : ''
    }${
      d.energy ? `<tr><th>用电</th><td class="wide" colspan="3">满负荷约 ${esc(d.energy.totalText)}</td></tr>` : ''
    }`;
}

function fillPorts(d) {
  if (d.stations?.length) {
    // 物流站居中：按站列出存储与站口
    const roleTxt = (r) => (r === 'supply' ? '供应' : r === 'warper' ? '星际需求' : '需求');
    $('ports').innerHTML = d.stations
      .map((st, k) => {
        const items = st.items.map((it) => `${esc(it.name)}（${roleTxt(it.role)}）`).join('、');
        const ps = st.ports
          .slice()
          .sort((a, b) => a.slot - b.slot)
          .map((p) => `${p.slot} 号口${p.dir === 'out' ? '出' : '进'} ${esc(p.item)}`)
          .join('，');
        return `<li>物流站 ${k + 1}（中心第 <span class="num">${st.x}</span> 列、第 <span class="num">${st.y}</span> 行）：${items}。${ps}</li>`;
      })
      .join('');
    return;
  }
  const lines = d.ports
    .sort((a, b) => (a.kind === b.kind ? b.y - a.y : a.kind === 'in' ? -1 : 1))
    .map((p) =>
      p.kind === 'in'
        ? `<li>${esc(p.item)} <span class="num">${fmt(p.rate)}</span>/分，从${p.side}边第 <span class="num">${p.y}</span> ${p.unit ?? '行'}送入</li>`
        : `<li>成品 ${esc(p.item)} <span class="num">${fmt(p.rate)}</span>/分，从${p.side}边第 <span class="num">${p.y}</span> ${p.unit ?? '行'}出来</li>`,
    );
  $('ports').innerHTML = lines.join('') || '<li>没有外部接口。</li>';
}

function fillNotes(d) {
  const li = [];
  if (d.array) {
    // 分馏塔阵列：说明换成它自己的
    for (const e of d.check.errors) li.push(`<li class="err">${esc(e)}</li>`);
    if (d.check.warnings.length) console.info('[dsp-handcraft] 检查提醒：\n' + d.check.warnings.map((x) => `- ${x}`).join('\n'));
    for (const n of d.array.notes) li.push(`<li>${esc(n)}</li>`);
    li.push('<li>图中 A~D 是四个氢循环（各接物流站一个出站口）；三角指向分馏塔的产物口。原图的高架有两种高度（0.5 和 1 层），分在 L2、L3 查看。</li>');
    $('notes').innerHTML = li.join('');
    return;
  }
  if (d.module) {
    const m = d.module;
    const n = split?.modules.length ?? 1;
    li.push(`<li>这是第 ${m.k + 1} 块（共 ${n} 块），${m.machines} 台工厂。产出：${m.makes.map((t) => `${esc(t.name)} ${fmt(t.rate)}/分`).join('、')}；要运来：${m.needs.map(esc).join('、') || '无'}。块与块之间隔 25 格以上再贴，物流站里放上运输机。</li>`);
  }
  // 只写玩家要知道、要动手的；规划器自己的过程和来由打到控制台（开发者工具里看），不占页面（用户 2026/10/07：提示别打扰玩家）
  const dev = [];
  if (d.check.ok && d.feasible) li.push('<li class="ok">检查通过。</li>');
  dev.push(...d.check.warnings);
  // 排不出可行的图时：图纸上方的红条已经说了怎么办，这里按问题种类合并成几行（几处、举一个例子），明细进控制台。
  // 图本身可行、出蓝图检查却报错（那是 bug）时照常逐条列出来
  const PEN = { tracks: '通道里带子太多，分拣器够不着', slots: '工厂一侧要接的物品超过分拣器位', shortfall: '有工厂取不到料', clash: '上下两行的分拣器撞在同一列', slow: '分拣器不够快', belt: '带子流量超过单条带运力', level: '高架叠不下', route: '有带子接不上', spray: '有带子留不出喷涂机的位置', power: '有工厂不在供电范围内', width: '超过宽度上限', height: '超过长度上限', aspect: '长宽比超过上限', long: '有带子超过长度上限', fill: '工厂行没排满' };
  const kinds = new Map();
  for (const p of d.penalties) {
    const k = kinds.get(p.kind) ?? { n: 0, msg: p.msg };
    k.n++;
    kinds.set(p.kind, k);
  }
  const hard = [...kinds].filter(([k]) => !['aspect', 'long', 'fill'].includes(k)).sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of hard.slice(0, 4)) li.push(`<li class="err">${PEN[k] ?? k}${v.n > 1 ? `（${v.n} 处）` : ''}，比如：${esc(v.msg)}</li>`);
  if (hard.length > 4) li.push(`<li class="err">还有 ${hard.slice(4).map(([k]) => PEN[k] ?? k).join('、')}。</li>`);
  for (const k of ['aspect', 'long']) if (kinds.has(k)) li.push(`<li>${esc(kinds.get(k).msg)}</li>`);
  dev.push(...d.penalties.map((p) => p.msg));
  if (d.feasible) {
    for (const e of d.check.errors) li.push(`<li class="err">${esc(e)}</li>`);
    for (const e of d.validate.errors) li.push(`<li class="err">${esc(e)}</li>`);
  } else {
    if (d.check.errors.length) li.push(`<li class="err">贴进游戏会有 ${d.check.errors.length} 处断带、分拣器够不着这类问题。</li>`);
    dev.push(...d.check.errors, ...d.validate.errors);
  }
  if (d.metrics.stationFallback && d.module) li.push('<li class="err">物流站没放进空地，改成了靠左侧站列。可以调高「搜索力度」再试。</li>');
  else if (d.metrics.stationFallback) li.push('<li class="err">物流站没放进空地，改成了靠左侧站列。可以在「外部供应」里拆出一部分再试。</li>');
  else if (d.metrics.moduleRetries) dev.push(`这一块第一次排时物流站没放进空地，换种子重排了 ${d.metrics.moduleRetries} 次`);
  if (!d.feasible && d.metrics.factories > 120) li.push(`<li class="err">产线太大，排不下。可以在「外部供应」里把电路板、处理器这类中间产物设为外部供应，分开生成。</li>`);
  if (d.metrics.lifted) li.push('<li>用到垂直传送带，要先解锁「超级磁场发生器」。</li>');
  if (d.metrics.orient) {
    const o = d.metrics.orient;
    if (o.used === 'v') li.push('<li>竖排：整张已经转好 90°，贴的时候不用再转。</li>');
    if (o.alt) dev.push(`另一个方向 ${o.alt.width}×${o.alt.height}、${o.alt.area} 格、传送带 ${o.alt.belts}${o.alt.feasible ? '' : '（不可行）'}`);
  }
  if (d.energy) li.push(`<li>${esc(d.energy.text)}。</li>`);
  if (!d.metrics.power) li.push('<li>没放供电，贴好后自己补。</li>');
  for (const b of d.burn ?? []) li.push(`<li>多余的${esc(b.item)} ${fmt(b.rate)}/分就地烧掉：火力发电厂 ${b.plants} 台，约 ${fmt(b.mw)} MW，要接在用得完这些电的电网上。</li>`);
  for (const n of d.burnNotes ?? []) li.push(`<li>${esc(n)}</li>`);
  if (d.latitude && !d.latitude.high) li.push(`<li>${esc(d.latitude.factory)}按赤道压缩的间距排，只能贴在赤道附近。</li>`);
  const ad = d.addons;
  if (ad?.spray) {
    // 增产剂从哪进：只说哪几座物流站（站口编号进控制台），没有站时从边缘入口
    const st = [...new Set((ad.lines ?? []).map((x) => x.match(/^物流站 (\d+)/)?.[1]).filter(Boolean))];
    const where = st.length ? `物流站 ${st.join('、')} 里放增产剂` : '增产剂从边缘的入口送进来';
    li.push(`<li>${where}，约 ${fmt(ad.spray.rate)}/分。</li>`);
    dev.push(`增产剂带 ${ad.lines?.length ?? 0} 条：${(ad.lines ?? []).join('、')}；吃到增产的配方：${ad.spray.units.join('、')}`);
  }
  if (ad?.warper) li.push(`<li>空间翘曲器放进物流站 ${ad.warper.home}${ad.warper.to.length ? `，传送带会送到物流站 ${ad.warper.to.join('、')}` : ''}。</li>`);
  dev.push(...(ad?.notes ?? []));
  if (d.byproducts?.length)
    li.push(`<li>副产物 ${d.byproducts.map((b) => `${esc(b.name)} ${fmt(b.rate)}/分`).join('、')} 单独一条带送出${d.stations?.length ? '进物流站' : '，要接走，不然会堵'}。</li>`);
  if (dev.length) console.info('[dsp-handcraft] 规划细节：\n' + dev.map((x) => `- ${x}`).join('\n'));
  $('notes').innerHTML = li.join('');
}

$('copy').addEventListener('click', async () => {
  const text = $('bp').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('bp').select();
    document.execCommand('copy');
  }
  for (const b of [$('copy'), $('copy-top')]) b.textContent = '已复制';
  setTimeout(() => {
    for (const b of [$('copy'), $('copy-top')]) b.textContent = '复制蓝图';
  }, 2000);
});
$('copy-top').addEventListener('click', () => $('copy').click());
// 标题栏里「需注意」点一下跳到检查
$('sheet-stats').addEventListener('click', (e) => {
  if (e.target.closest('.warn')) $('notes').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('sheet-stats').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.warn')) {
    e.preventDefault();
    $('notes').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

/** 页面初始状态：图纸参数与物品表在画布下方；布局细节展开（用户 2026/10/06），设备和集装收起（摘要一行） */
function initView() {
  $('result-body').append($('sheet-foot'));
  $('more').open = false; // 布局细节不常用，收起放最后；设备常要改，展开（用户 2026/10/07）
  $('equip').open = true;
  $('stack').open = false;
  syncOptionSelects();
  togglePile();
  toggleStitch();
  renderMore();
}
// ---------- 从别的网页带过来的方案（地址里的 #plan=，见 handoff.js） ----------
// 目标、配方、设备先填好；外部供应是物品 ID，等物品列表到了换成名字，再按建议补齐（需要原油精炼厂等的中间产物），然后自动排一次
let handoff = readHandoff(location.hash);
function applyHandoff() {
  state.targets = handoff.targets.map((t) => ({ ...t }));
  state.recipes = { ...handoff.recipes };
  state.ext = new Set();
  for (const [k, v] of Object.entries(handoff.options)) if (document.querySelector(`input[name="${k}"][value="${v}"]`)) state[k] = v;
  if (handoff.labstack) state.labstack = labStackOf(handoff.labstack);
  if (!state.splitPicked) state.split = state.targets.length > 1 ? '1' : '0';
  for (const name of OPTION_NAMES) {
    const el = document.querySelector(`input[name="${name}"][value="${state[name]}"]`);
    if (el) el.checked = true;
  }
  $('labstack').value = state.labstack;
  // 地址里的方案只用一次：刷新页面时保留自己后来的改动（设置已经存下了）
  history.replaceState(null, '', location.pathname + location.search);
}
function takeHandoffExt() {
  if (!handoff || handoff.took) return;
  handoff.took = true;
  const missing = state.targets.filter((t) => !byId.get(t.id));
  if (missing.length) {
    handoff.auto = false;
    setStatus(`带过来的目标里有 ${missing.length} 个这里不认识（物品 ID ${missing.map((t) => t.id).join('、')}），请在左上角重新选。`, true);
    return;
  }
  for (const id of handoff.ext) if (byId.get(id)) state.ext.add(byId.get(id).name);
  saveSettings();
  renderSpec();
  setStatus(`已按${handoff.from ? `「${handoff.from}」` : ''}带过来的方案填好目标、配方和设备，正在排布…`);
  autoSuggest = true;
  requestChain();
}
// 页面开着时又带来一份方案（同一个标签页里再点了一次「生成蓝图」）：重新加载，按新方案来
window.addEventListener('hashchange', () => {
  if (readHandoff(location.hash)) location.reload();
});
// 嵌在别的网页里时，图标可以由那边给：window.DSPHC.icon(物品) 返回图片地址，准备好后发 dsphc-icons 事件
window.addEventListener('dsphc-icons', () => {
  renderSpec();
  renderCatalog();
  renderExt();
});
initOptionSelects();
loadSettings();
if (handoff) applyHandoff();
initView();
renderMore();
togglePile();
// 页面旁边有 icons/ 目录就用其中的图片（嵌在别的网页里、图标由那边给时不用找）
if (!window.DSPHC) {
  const probe = new Image();
  probe.onload = () => {
    iconMode = true;
    renderSpec();
    renderCatalog();
    renderExt();
  };
  probe.src = 'icons/iron-ore.png';
}
document.querySelectorAll('[data-page]').forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.page) === state.page)));
// 多线程：把打包好的脚本源码交给后台线程，由它再开帮手线程（线程数 = 逻辑核数）
send({ type: 'init', src: WORKER_SRC, threads: navigator.hardwareConcurrency || 4 });
send({ type: 'catalog', id: ++catId, raw: [] });
