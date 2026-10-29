// 页面逻辑：物品面板选目标 → 外部供应弹窗 → 交给后台线程规划 → 画图纸、填标题栏、给出蓝图字符串。
/* global WORKER_SRC */
import { SPRITE, glyphSvg, glyphOf } from './glyphs.js';
import { sliceRoutes, drawingSvg, routeColor, linkedRuns, footprint, LINE, FINE } from './drawing.js';
import { createViewer } from './viewer.js';
import { readHandoff, readDefs } from './handoff.js';

const $ = (id) => document.getElementById(id);
const STORE = 'dsp-handcraft:settings';
const DEFAULTS = { targetId: 6005, rate: 60, ext: [], recipes: {}, assembler: '2303', smelter: '2302', chemical: '2309', lab: '2901', labstack: 15, belt: '3', sorter: '2014', power: 'substation', station: 'ils', pile: '1', spray: '0', proslot: '1', warper: '0', maxwidth: '', maxheight: '', aspect: '', orient: 'h', effort: 'quick', page: 1, chemwide: '0', defs: null, supply: '', dist: '0', stationPrefs: null };
const OPTION_NAMES = ['assembler', 'smelter', 'chemical', 'chemwide', 'lab', 'belt', 'sorter', 'station', 'supply', 'dist', 'pile', 'power', 'spray', 'proslot', 'warper', 'maxwidth', 'maxheight', 'aspect', 'effort']; // 排布方向去掉了，统一横排（用户 2026/10/07）；自动切分、切分后的蓝图去掉了，网页不切块（用户 2026/10/27）
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
/** 第 z 层：楼层按 z 从小到大排、有半层（drawing.js 的 sliceRoutes），下标不是 z */
const floorAt = (z) => floors.find((f) => f.z === z);
const view = { level: 'all', focus: '', selected: '', factory: '', station: null, machine: null, buildings: true, sorters: true, power: false }; // level：'all' 是总览，数字是那层的 z（0 = L1 地面，0.5 是半层）；selected 是单击的线段，factory 是单击的工厂的介绍，最多有一个；station 是单击的物流站（第几座）
let last = null;
let busy = false;
let reqId = 0;
const presses = new Map(); // 每套输入点过几次「生成蓝图」：第几次就用第几个种子（worker.js 的 AGAIN_SEED）
let catId = 0;
let chainId = 0;
let chainData = null;
let extFocus = null; // 外部供应弹窗里悬停或聚焦着的物品（重画以后接着亮）
let extG = null; // 外部供应弹窗现在画着的依赖图（extGraph）
let extAnchor = null; // 外部供应弹窗里刚点的节点在画布上的位置（重画后让它留在原处）
let forecastData = null; // 后台的预告（forecast）：建筑数、预计用时、用电、当前产线用到的物品
let forecastId = 0;
let forecastTimer = null;
let autoSuggest = false;
let firstVisit = false; // 第一次打开（没存过设置）：默认目标也先按建议补外部供应，和选目标时一样
let iconMode = false; // 页面旁边有 icons/ 目录时改用其中的图片
let pickMode = { add: true }; // 物品面板这次是添加目标还是更换第 i 个目标

const viewer = createViewer({ box: $('drawing'), enabled: () => true, onSelect: selectRoute, onFactory: selectFactory, onStation: selectStation, onMachine: selectMachine, onClear: clearRoute, onZoom: (n) => $('zoom-label').textContent = `${n}%`, zoomable: () => $('sheet').classList.contains('is-expanded') });

// ---------- 后台线程（打不开时退回到主线程运行） ----------
// 有的浏览器不允许本地文件启动后台线程，而且是异步报错；在第一条回复到达之前出错就整体切到主线程。
function inlineRunner() {
  const api = { onmessage: null, postMessage: null, inline: true };
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
// 测速（worker.js 的 runBench）：页面好了、闲下来时让后台测一次这台机器多快，开搜前的预计按它折算；每次打开页面只测一次，页面上不显示。
// 后台线程打不开、整个跑在主线程上时不测（会让页面卡一下），预计按参照机算
let benchAsked = false;
function scheduleBench() {
  if (benchAsked || runner?.inline) return;
  benchAsked = true;
  setTimeout(() => {
    if (!busy) send({ type: 'bench' });
  }, 1500);
}
function handle(m) {
  if (m.type === 'catalog' && m.id === catId) {
    catalog = m.list;
    byId = new Map(catalog.map((x) => [x.id, x]));
    migrateTarget();
    takeHandoffExt();
    renderCatalog();
    renderSpec();
    if (firstVisit && !handoff) {
      // 第一次打开：默认的引力矩阵要把精炼油设为外部供应才排得了，照选目标时那样先按建议设好，不然第一次点「生成蓝图」就报错
      firstVisit = false;
      autoSuggest = true;
      requestChain();
    }
    requestForecast();
    scheduleBench();
  } else if (m.type === 'bench') {
    console.info(`[dsp-handcraft] 测速 ${Math.round(m.ms)} 毫秒（${m.threads} 个线程）`);
    requestForecast(); // 测完速，预告的用时按这台机器重算一次
  } else if (m.type === 'progress' && m.id === reqId) {
    progress = { ...progress, ...m, est0: progress?.est0 ?? m.est ?? null }; // est0 是开搜前报的第一个预计，之后不改
  } else if (m.type === 'preview' && m.id === reqId) {
    onPreview(m); // 搜索中的快照：观摩退火
  } else if (m.type === 'chain' && m.id === chainId) {
    onChain(m.data);
  } else if (m.type === 'forecast' && m.id === forecastId) {
    forecastData = m.data;
    renderForecast();
    renderExtChips(); // 只重画外部供应那一栏：renderSpec 会重建目标的产量输入框，正在输入时会丢焦点
  } else if (m.type === 'result' && m.id === reqId) {
    finish(m.data);
  } else if (m.type === 'patched') {
    patchWaiters.get(m.id)?.(m.data);
    patchWaiters.delete(m.id);
  }
}

// ---------- 设置的保存与读取 ----------
function loadSettings() {
  let s = {};
  try {
    const stored = localStorage.getItem(STORE);
    firstVisit = !stored;
    s = JSON.parse(stored || '{}');
  } catch {
    /* 无痕模式等情况下读不到，使用默认值 */
  }
  Object.assign(state, DEFAULTS, s);
  // 排布方向：上一版默认「自动」，效果不好，改回默认横排；那时存下的「自动」当作没选过（以后自己选的才记，见 orientPicked）
  if (state.orient === 'auto' && !s.orientPicked) state.orient = 'h';
  // 化工厂间距 2026/10/19 改成默认只限赤道，换了新键 chemwide：旧键 chemtight（那时默认任何纬度）不认，以前存过的也拿新的默认值
  delete state.chemtight;
  // 箱子 2026/10/26 改成左侧一列仓组（side-s / side-l），以前存的排进行里那种（box-s / box-l）换过来；「物流方式」的两个子选项记上次选的
  if (state.supply === 'box-s' || state.supply === 'box-l') state.supply = state.supply.replace('box', 'side');
  // 物流站一律放进空地、网页不再切块（用户 2026/10/27 去掉了「物流站位置」「自动切分」「切分后的蓝图」）：以前存的「靠左侧站列」改回放进空地，
  // 切分的几项和记的「上次选的站位」删掉，存设置时不再带
  if (state.station === 'ils-side') state.station = 'ils';
  for (const k of ['split', 'stitch', 'splitPicked', 'stationPick']) delete state[k];
  state.boxPick = ['side-s', 'side-l'].includes(s.boxPick) ? s.boxPick : state.supply || 'side-s';
  // 旧版本存的是物品名和逗号分隔的外部供应
  // 新配方：{ 物品 ID: 配方 ID }，只记开了新配方的物品
  state.recipes = s.recipes && typeof s.recipes === 'object' ? Object.fromEntries(Object.entries(s.recipes).filter(([, v]) => Number(v) > 0)) : {};
  delete state.burn; // 就地烧掉 2026/10/26 从网页上拿掉了（命令行还有），以前存的不认
  state.defs = readDefs(s.defs); // 上次从计算器带过来的新物品、新配方（地址里的方案只用一次，刷新后靠这份）
  state.ext = new Set(Array.isArray(s.ext) ? s.ext : typeof s.raw === 'string' ? s.raw.split(/[,，、\s]+/).filter(Boolean) : []);
  state.legacyTarget = typeof s.target === 'string' ? s.target : null;
  // 多个目标：旧版本只有 targetId/rate
  state.targets = Array.isArray(s.targets) && s.targets.length ? s.targets.map((t) => ({ id: Number(t.id), rate: Number(t.rate) || 60 })) : [{ id: Number(s.targetId ?? DEFAULTS.targetId), rate: Number(s.rate ?? DEFAULTS.rate) }];
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
  requestForecast(); // 每一处改设置都经过这里
}

// 图纸上方一排下拉按钮（用户 2026/10/26）：供电、物流方式、传送带、分拣器、熔炉、制造台、化工厂、研究站、喷增产剂。
// 按钮上只写当前选的（模板里各项 span 的 data-pill），悬停、键盘聚焦或点一下展开；选了就勾上左栏里藏起来的那个单选、发 change，设置还是那一份
const PILL_NAMES = ['power', 'logistics', 'belt', 'sorter', 'smelter', 'assembler', 'chemical', 'lab', 'spray'];
// 按钮上字前面的小图标（16 格画、14 像素显示，线条用字色）：一组选项一个，同组的几档共用
const PILL_ICONS = {
  power: '<path d="M9.5 1.5L3.5 9h4l-1 5.5 6-7.5h-4z"/>', // 闪电
  logistics: '<path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM2.5 4.5L8 7.5l5.5-3M8 7.5v7"/>', // 箱子
  belt: '<path d="M1.5 8h13M11 4.5L14.5 8 11 11.5"/>', // 带箭头的横线
  sorter: '<path d="M2.5 13.5l3-9 4.9 3.8"/><circle cx="12" cy="9.5" r="2"/>', // 折一下的臂，头上一个小圆
  smelter: '<path d="M8 1.5c.5 2.7 4.5 4.4 4.5 8.5a4.5 4.5 0 0 1-9 0c0-1.8.7-3.2 1.8-4.2.3 1.4.9 2.3 1.9 2.8-.4-2.7-.1-5 .8-7.1z"/>', // 火苗
  assembler: '<circle cx="8" cy="8" r="3.8"/><path d="M8 4.2V1.6M8 11.8v2.6M11.3 6.1l2.25-1.3M11.3 9.9l2.25 1.3M4.7 6.1L2.45 4.8M4.7 9.9l-2.25 1.3"/>', // 齿轮
  chemical: '<path d="M5.5 1.5h5M6.5 1.5V6L2.7 12.6a1.2 1.2 0 0 0 1 1.9h8.6a1.2 1.2 0 0 0 1-1.9L9.5 6V1.5M4.2 10h7.6"/>', // 烧瓶
  lab: '<circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/><ellipse cx="8" cy="8" rx="6.5" ry="2.7" transform="rotate(-30 8 8)"/>', // 原子
  spray: '<path d="M8 1.5c.6 3.5 3 5.9 6.5 6.5-3.5.6-5.9 3-6.5 6.5-.6-3.5-3-5.9-6.5-6.5 3.5-.6 5.9-3 6.5-6.5z"/>', // 四角星
};
const pillIcon = (name) => `<span class="pill-ico" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${PILL_ICONS[name] ?? ''}</svg></span>`;
const legendOf = (field) => field.querySelector('legend').firstChild.textContent.trim(); // 图例后面可能跟着 beta 标
const pillText = (radio) => radio.nextElementSibling.dataset.pill || radio.nextElementSibling.textContent;
function initPills() {
  const bar = $('toolbar');
  for (const name of PILL_NAMES) {
    const field = document.querySelector(`.seg[data-name="${name}"]`);
    if (!field) continue;
    field.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'pill-wrap';
    wrap.dataset.option = name;
    wrap.dataset.label = legendOf(field);
    wrap.innerHTML = `<button type="button" class="pill" aria-haspopup="menu" aria-expanded="false">${pillIcon(name)}<span class="pill-text"></span></button><div class="pill-menu" role="menu" aria-label="${esc(wrap.dataset.label)}">${[...field.querySelectorAll('input[type="radio"]')].map((el) => `<button type="button" role="menuitemradio" tabindex="-1" data-value="${esc(el.value)}">${esc(pillText(el))}</button>`).join('')}</div>`;
    // 鼠标、焦点从外面进来：又可以弹出了；焦点离开就收起
    wrap.addEventListener('pointerenter', () => pillReady(wrap));
    wrap.addEventListener('focusin', (e) => !wrap.contains(e.relatedTarget) && pillReady(wrap));
    wrap.addEventListener('focusout', (e) => !wrap.contains(e.relatedTarget) && closePill(wrap, false));
    bar.append(wrap);
  }
  bar.addEventListener('click', (e) => {
    const wrap = e.target.closest('.pill-wrap');
    const item = e.target.closest('[data-value]');
    if (item) pickPill(wrap, item.dataset.value);
    else if (e.target.closest('.pill')) wrap.classList.contains('open') ? closePill(wrap, true) : openPill(wrap, false);
  });
  // 键盘：按钮上回车、空格、上下键展开，左右键换到相邻的按钮；菜单里上下键挪、回车或空格选、Esc 收起
  bar.addEventListener('keydown', (e) => {
    const wrap = e.target.closest('.pill-wrap');
    if (!wrap) return;
    const items = [...wrap.querySelectorAll('[data-value]')];
    const i = items.indexOf(e.target);
    if (e.key === 'Escape') {
      e.preventDefault();
      closePill(wrap, true);
    } else if (i < 0 && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      openPill(wrap, true);
    } else if (i < 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const pills = [...bar.querySelectorAll('.pill')];
      const k = pills.indexOf(e.target);
      if (k >= 0) pills[(k + (e.key === 'ArrowLeft' ? pills.length - 1 : 1)) % pills.length].focus();
    } else if (i >= 0 && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pickPill(wrap, e.target.dataset.value);
    } else if (i >= 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const n = items.length;
      items[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowUp' ? n - 1 : 1)) % n].focus();
    }
  });
  bar.addEventListener('keyup', (e) => e.key === ' ' && e.preventDefault()); // 空格按下时已经处理过，松开时别让浏览器再点一下
  // 点到别处就收起点开的菜单（触屏上靠这个）
  document.addEventListener('pointerdown', (e) => bar.querySelectorAll('.pill-wrap.open').forEach((w) => !w.contains(e.target) && closePill(w, false)));
}
/** 鼠标、焦点刚进来：去掉「先别弹出」，别的点开的收起；菜单往右放不下就靠右展开 */
function pillReady(wrap) {
  wrap.classList.remove('shut');
  document.querySelectorAll('.pill-wrap.open').forEach((w) => w !== wrap && closePill(w, false));
  const menu = wrap.querySelector('.pill-menu');
  menu.style.display = 'block'; // 量一下菜单多宽
  wrap.classList.toggle('flip', wrap.getBoundingClientRect().left + menu.offsetWidth > document.documentElement.clientWidth - 8);
  menu.style.display = '';
}
/** 点开（触屏、键盘）；focusItem：焦点挪到当前选的那项 */
function openPill(wrap, focusItem) {
  pillReady(wrap);
  wrap.classList.add('open');
  wrap.querySelector('.pill').setAttribute('aria-expanded', 'true');
  if (focusItem) (wrap.querySelector('[aria-checked="true"]') || wrap.querySelector('[data-value]')).focus();
}
/** 收起；shut：选了一项、按了 Esc、再点一下按钮，鼠标和焦点再进来之前悬停、聚焦都不弹出 */
function closePill(wrap, shut) {
  wrap.classList.remove('open');
  wrap.querySelector('.pill').setAttribute('aria-expanded', 'false');
  if (!shut) return;
  if (wrap.contains(document.activeElement)) wrap.querySelector('.pill').focus({ preventScroll: true }); // 焦点在菜单里（键盘）就回到按钮上
  wrap.classList.add('shut');
}
/** 选了一项：勾上藏着的单选、发 change（各处原有的处理照常跑），按钮上的字跟着换 */
function pickPill(wrap, value) {
  closePill(wrap, true);
  const radio = document.querySelector(`input[name="${wrap.dataset.option}"][value="${value}"]`);
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  syncOptionSelects();
}
/** 物流方式：传送带 / 传送带+箱子 / 物流站，由「物流站」（藏着的单选，一律放进空地）「箱子」两个设置推出来；选了就把那两个设置改过去，箱子用上次选的 */
const logisticsOf = () => (document.querySelector('input[name="station"]:checked')?.value ? 'station' : document.querySelector('input[name="supply"]:checked')?.value ? 'box' : '');
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
function syncLogistics() {
  setRadio('logistics', logisticsOf());
  syncOptionSelects();
}
document.querySelectorAll('input[name="logistics"]').forEach((el) => el.addEventListener('change', () => {
  setRadio('station', el.value === 'station' ? 'ils' : '');
  setRadio('supply', el.value === 'box' ? state.boxPick || 'side-s' : '');
  syncOptionSelects();
  readOptions();
  saveSettings();
  togglePile();
  renderMore();
}));
document.querySelectorAll('input[name="station"], input[name="supply"]').forEach((el) => el.addEventListener('change', () => {
  if (el.value && el.name === 'supply') state.boxPick = el.value;
  syncLogistics();
  saveSettings();
}));

// 新版下拉框与旧版单选按钮共用同一组选项及设置。
function initOptionSelects() {
  document.querySelectorAll('.seg[data-name]').forEach((field) => {
    const name = field.dataset.name;
    const label = legendOf(field);
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
  syncPills();
}
/** 图纸上方那排按钮：写当前选的，菜单里勾上当前那项 */
function syncPills() {
  document.querySelectorAll('.pill-wrap').forEach((wrap) => {
    const cur = document.querySelector(`input[name="${wrap.dataset.option}"]:checked`);
    const pill = wrap.querySelector('.pill');
    const text = wrap.querySelector('.pill-text');
    text.textContent = cur ? pillText(cur) : '';
    pill.setAttribute('aria-label', `${wrap.dataset.label}：${text.textContent}`);
    wrap.querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === cur?.value)));
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
/** 图纸上原料入口旁边的物品图标（drawing.js 的 icon）：图片和物品面板同一个来源，没有图片就用线条图形；以 (0, 0) 为中心、0.8 格见方 */
function drawIcon(itemId) {
  const it = byId.get(Number(itemId));
  if (!it) return null;
  const src = window.DSPHC?.icon?.(it) || (iconMode && it.icon ? `icons/${it.icon}.png` : '');
  if (src) return `<image href="${esc(src)}" x="-0.4" y="-0.4" width="0.8" height="0.8"/>`;
  const { id, fill } = glyphOf(it);
  return `<svg x="-0.4" y="-0.4" width="0.8" height="0.8" viewBox="0 0 24 24"><use href="#g-${id}" style="--fill:${fill}" stroke="${FINE}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
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
  extFocus = null;
  extAnchor = null;
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
/**
 * 外部供应弹窗的依赖图（用户 2026/10/26 第二版：一种物品只画一张卡，一个原料被几个产物用，就从那几个产物各拉一条线到它这张卡上）：
 * 原料在上、产物在下，最终产物在最下面（用户 2026/10/27），直角细线从原料往下送进产物——下面几个函数照「产物在上」算，
 * renderExt 摆卡片时上下翻过来、连线整层翻过来。外部供应的没有原料（它的原料已不在产线里），不再需要的（dropped）不画。
 * 原矿（和黑雾掉落、临界光子这类没有配方的原料）也画（用户 2026/10/27），副产物画在出它的那组工厂上面
 */
// 卡宽、量不到时的卡高、同层卡片的间距、层与层之间连线区的高、四周边距；产物底边到它横线的距离、同层产物的横线依次错开多少；
// 重心法来回扫几遍、摆好以后松弛几轮、最后逐层对调相邻卡片试几轮
const GRAPH = { w: 156, h: 50, gap: 12, link: 40, pad: 14, bar: 10, lane: 4, sweeps: 4, relax: 4, swaps: 2 };
/**
 * 依赖图的节点和边（纯函数）：节点是目标、产线里还要的中间产物（含外部供应的）、原料（state raw）、副产物（state by，编号是 BY + 物品编号，
 * 和规划器一样当另一种物品），边是还在用的「原料 → 产物」（d.edges 的 from 是原料、to 是用它的产物；副产物的边 from 是出它的那组工厂的产物、
 * to 是副产物，state by），两头都在、重复的只留一条。初始顺序：目标在前，其余按在 edges 里第一次作为原料出现的先后
 */
const BY = 100000;
/** 原料卡上的小字：原矿、黑雾掉落，别的没有配方的（临界光子、分馏阵列吃的氢）是「由外部供给」 */
const rawTag = (u) => (u.type === 1 ? '原矿' : u.type === 10 ? '黑雾掉落' : '由外部供给');
function extGraph(d) {
  const goals = d.goals.map((g) => g.id);
  const raws = (d.raws || []).filter((r) => r.id != null).map((r) => ({ ...r, state: 'raw' }));
  const mid = [...d.goals, ...d.units].filter((u) => goals.includes(u.id) || u.state !== 'dropped');
  const inLine = new Set(mid.map((u) => u.id));
  // 副产物：同一种物品几组工厂都出时合成一张卡
  const bys = new Map();
  const byEdges = [];
  for (const b of d.byproducts || []) {
    if (!inLine.has(b.ofId)) continue;
    const id = BY + b.id;
    if (bys.has(id)) bys.get(id).rate += b.rate;
    else bys.set(id, { id, item: b.id, name: b.name, type: b.type, rate: b.rate, state: 'by' });
    byEdges.push({ from: b.ofId, to: id, rate: b.rate, state: 'by' });
  }
  // 副产物、和主产物同一组工厂出的，也从出它的那组工厂的原料连下来（用户 2026/10/27：副产的氢也连到可燃冰）；via 记着是借来的，
  // 底部说明里不重复写流量
  const into = (id) => d.edges.filter((e) => e.to === id && e.state !== 'dropped' && e.state !== 'by');
  const via = [
    ...(d.byproducts || []).filter((b) => inLine.has(b.ofId)).flatMap((b) => into(b.ofId).map((e) => ({ ...e, to: BY + b.id, via: true }))),
    ...mid.filter((u) => u.co != null && u.state === 'line').flatMap((u) => into(u.co).map((e) => ({ ...e, to: u.id, via: true }))),
  ];
  const all = [...mid, ...raws, ...bys.values()];
  const has = new Set(all.map((u) => u.id));
  const seen = new Set();
  const edges = [...d.edges, ...byEdges, ...via].filter((e) => {
    const key = `${e.from}>${e.to}`;
    if (e.state === 'dropped' || e.from === e.to || !has.has(e.from) || !has.has(e.to) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = new Map();
  for (const id of [...goals, ...edges.map((e) => e.from), ...all.map((u) => u.id)]) if (!rank.has(id)) rank.set(id, rank.size);
  return { nodes: all.sort((a, b) => rank.get(a.id) - rank.get(b.id)), edges };
}
/**
 * 依赖图的布局（纯函数，不碰页面）。nodes 是 [{ id }]（按初始顺序），edges 是 [{ from, to }]。
 * 分层：没人用的（没有以它为 from 的边）在第 0 层，其余 = 1 + 用它的产物里最深的那层，所以每条线都从上面的产物往下连到原料，可以跨几层。
 * 副产物（state by）不参与这个算法，放在出它的那组工厂上面一层（几组出它时按最上面那组），放不下（工厂在第 0 层）就整张往下挪一层。
 * 同层的顺序：从初始顺序起，重心法上下来回扫（自上而下按用它的产物的平均位置排，自下而上按它的原料的平均位置排），
 * 每扫一遍按真实画法数一次交叉和竖线穿过的卡片（graphCrossings），留最少的那个顺序；再逐层试着对调相邻两张卡，少了就留下。
 * 横坐标：从第 0 层起逐层放，目标是已放好的父节点（用它的产物）中心的平均，没有父的接着前一个放；再松弛几轮，每个节点挪向它的父和子中心的平均。
 * 每层都在「顺序不变、相邻中心距 ≥ 卡宽 + 间距」下求离目标最近的位置（加权最小二乘：挤在一起的合成一块，整块放在目标的加权平均处），
 * 所以一排原料在产物下面居中排开，不会一路往右推。纵向：每层卡高 + 连线区 o.link（这一层有原料的产物多、横线放不下时这层的连线区加高）。
 * 返回 pos（和 nodes 一一对应：x 卡片中心、y 卡片顶、level 层号、lane 这个产物的横线在本层的序号，没有原料的是 -1）和总宽高
 */
function layoutGraph({ nodes, edges }, o = GRAPH) {
  const n = nodes.length;
  if (!n) return { pos: [], width: 2 * o.pad, height: 2 * o.pad };
  const at = new Map(nodes.map((u, k) => [u.id, k]));
  const ups = nodes.map(() => []); // 用它的产物
  const downs = nodes.map(() => []); // 它的原料
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (a == null || b == null || a === b) continue;
    ups[a].push(b);
    downs[b].push(a);
  }
  // 分层（生产图无环；保险起见，递归路径上已经在算的不再往下走，那条边不算）
  const by = nodes.map((u) => u.state === 'by');
  const level = Array(n).fill(-1);
  const busy = Array(n).fill(false);
  const lv = (k) => {
    if (level[k] >= 0 || busy[k]) return level[k];
    busy[k] = true;
    let l = 0;
    for (const p of ups[k]) if (!by[p]) l = Math.max(l, lv(p) + 1);
    busy[k] = false;
    return (level[k] = l);
  };
  nodes.forEach((_, k) => lv(k));
  nodes.forEach((_, k) => by[k] && downs[k].length && (level[k] = Math.min(...downs[k].map((c) => level[c])) - 1));
  const lift = -Math.min(0, ...level);
  if (lift) level.forEach((l, k) => (level[k] = l + lift));
  const layer = Array.from({ length: Math.max(...level) + 1 }, () => []);
  nodes.forEach((_, k) => layer[level[k]].push(k));
  const top = [];
  for (let l = 0, y = o.pad; l < layer.length; l++) {
    top.push(y);
    y += o.h + Math.max(o.link, 2 * o.bar + o.lane * (layer[l].filter((k) => downs[k].length).length - 1));
  }
  const height = top.at(-1) + o.h + o.pad;
  const W = o.w + o.gap;
  const x = Array(n).fill(0);
  const avg = (ks) => ks.reduce((s, k) => s + x[k], 0) / ks.length;
  // 一层按给的顺序放：相邻中心距 ≥ W，离目标 t 最近（权重 wt）。z = x − 序号 × W 要单调不减，就是带权的保序回归：从左往右，比前一块的平均小就并进去
  const put = (ks, t, wt) => {
    const blocks = [];
    ks.forEach((_, i) => {
      let b = { s: wt[i] * (t[i] - i * W), w: wt[i], from: i, to: i };
      for (let a = blocks.at(-1); a && a.s / a.w >= b.s / b.w; a = blocks.at(-1)) {
        blocks.pop();
        b = { s: a.s + b.s, w: a.w + b.w, from: a.from, to: b.to };
      }
      blocks.push(b);
    });
    for (const b of blocks) for (let i = b.from; i <= b.to; i++) x[ks[i]] = b.s / b.w + i * W;
  };
  // 放第 l 层：每个节点的目标是 near(k) 里那些中心的平均（一个都没有时用 alone(k, 前一个的目标)）；sort 为真时先按目标重排（重心法，目标一样的保持原顺序）
  const pass = (l, near, alone, sort) => {
    let ks = layer[l];
    const t = new Map();
    const wt = new Map();
    let prev = null;
    for (const k of ks) {
      const ns = near(k);
      t.set(k, ns.length ? avg(ns) : alone(k, prev));
      wt.set(k, Math.max(1, ns.length));
      prev = t.get(k);
    }
    if (sort) ks = layer[l] = [...ks].sort((a, b) => t.get(a) - t.get(b));
    put(ks, ks.map((k) => t.get(k)), ks.map((k) => wt.get(k)));
  };
  const parents = (l) => (k) => ups[k].filter((p) => level[p] < l);
  const kids = (l) => (k) => downs[k].filter((c) => level[c] > l);
  const stay = (k) => x[k];
  const next = (k, prev) => (prev == null ? 0 : prev + W);
  const down = (sort) => layer.forEach((_, l) => pass(l, parents(l), next, sort));
  const up = (sort) => layer.map((_, l) => l).reverse().forEach((l) => pass(l, kids(l), stay, sort));
  const place = () => {
    down(false);
    for (let r = 0; r < o.relax; r++) {
      const ls = layer.map((_, l) => l);
      for (const l of r % 2 ? ls.reverse() : ls) pass(l, (k) => [...ups[k], ...downs[k]], stay, false);
    }
  };
  // 取整（中心距仍 ≥ W），整体挪到左边距；同层有原料的产物按 x 排出横线序号
  const finish = () => {
    const X = Array(n);
    for (const ks of layer) ks.forEach((k, i) => (X[k] = i ? Math.max(Math.round(x[k]), X[ks[i - 1]] + W) : Math.round(x[k])));
    const dx = o.pad + o.w / 2 - Math.min(...X);
    const pos = nodes.map((_, k) => ({ x: X[k] + dx, y: top[level[k]], level: level[k], lane: -1 }));
    for (const ks of layer) ks.filter((k) => downs[k].length).forEach((k, i) => (pos[k].lane = i));
    return { pos, width: Math.max(...X) + dx + o.w / 2 + o.pad, height };
  };
  const cost = () => {
    const c = graphCrossings({ nodes, edges }, finish(), o);
    return c.crossings + c.passes;
  };
  place();
  let best = { cost: cost(), order: layer.map((ks) => [...ks]) };
  for (let i = 0; i < o.sweeps; i++)
    for (const sweep of [down, up]) {
      sweep(true);
      place();
      const c = cost();
      if (c < best.cost) best = { cost: c, order: layer.map((ks) => [...ks]) };
    }
  best.order.forEach((ks, l) => (layer[l] = ks));
  for (let r = 0, better = true; better && r < o.swaps; r++) {
    better = false;
    for (const ks of layer)
      for (let i = 1; i < ks.length; i++) {
        [ks[i - 1], ks[i]] = [ks[i], ks[i - 1]];
        place();
        const c = cost();
        if (c < best.cost) {
          best.cost = c;
          better = true;
        } else [ks[i - 1], ks[i]] = [ks[i], ks[i - 1]];
      }
  }
  place();
  return finish();
}
/**
 * 依赖图连线的走法（纯函数）：每个有原料的产物一组 { to, px, bottom, bar, drops: [{ from, x, top }] }（to、from 是 nodes 的下标）——
 * 从产物底边中点 (px, bottom) 往下到横线 y = bar（底边下 o.bar，同层的产物按 x 依次再错开 o.lane），横线从最左的落点延到最右的落点（含 px），
 * 再竖直往下到每个原料卡片顶边（top）上的落点 x。一个原料被 k 个产物用时，顶边上均匀分开 k 个落点，按产物的 x 从左到右分给它们；
 * 跨层的线落在均分点上会从中间层的卡片后面穿过时，在顶边上另找一个不被挡住的点（保持左右次序，相邻至少隔 8），找不到就还用均分点；
 * 产物的中点正对着原料卡的顶边时优先落在那里，一根竖线直通、不拐台阶（用户 2026/10/27：硅石到高纯硅块差几像素也拐一下，很丑）；
 * 产物只有这一种原料、两张卡左右有重叠时，产物那头也不必在中点（返回的 px 跟着挪），从重叠里离产物中点最近的地方直通
 */
function graphRoutes({ nodes, edges }, L, o = GRAPH) {
  const at = new Map(nodes.map((u, k) => [u.id, k]));
  const users = new Map(); // 原料 → 用它的产物
  const groups = new Map(); // 产物 → 它的落点
  const ings = new Map(); // 产物 → 它的原料
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (a == null || b == null || a === b) continue;
    (users.get(a) || users.set(a, []).get(a)).push(b);
    (ings.get(b) || ings.set(b, []).get(b)).push(a);
    groups.set(b, []);
  }
  // 竖线能直通的位置：只有一种原料的产物在两张卡（各缩进 8）重叠的那段里取离产物中点最近的点，别的产物就是它的中点；
  // 两张卡左右不重叠就没有（null）——以前退到重叠段的端点上，箭头跑到产物卡外面、线悬在半空（用户 2026/10/27 截图）
  const inner = (k) => [L.pos[k].x - o.w / 2 + 8, L.pos[k].x + o.w / 2 - 8];
  const want = (p, a) => {
    const [l, r] = ings.get(p).length === 1 ? [Math.max(inner(p)[0], inner(a)[0]), Math.min(inner(p)[1], inner(a)[1])] : [L.pos[p].x, L.pos[p].x];
    return l <= r ? Math.min(Math.max(L.pos[p].x, l), r) : null;
  };
  const stem = new Map(); // 产物 → 竖线从它哪里出（挪了的才记）
  const bar = (p) => L.pos[p].y + o.h + o.bar + o.lane * Math.max(0, L.pos[p].lane);
  const cheapest = (xs) => xs.reduce((m, t) => (t.cost < m.cost ? t : m));
  for (const [a, ps] of users) {
    const P = L.pos[a];
    const [lo, hi] = [P.x - o.w / 2 + 8, P.x + o.w / 2 - 8];
    const gap = Math.min(8, Math.floor(o.w / (ps.length + 1)));
    ps.sort((p, q) => L.pos[p].x - L.pos[q].x || L.pos[p].level - L.pos[q].level);
    // 每条线的候选落点：产物正下方（直通，倒扣一点）、均分点、顶边两头、半路挡着的卡片两边（离卡片 4）；
    // 落在挡路卡片范围里的罚 1000，其余按离均分点多远罚
    const cands = ps.map((p, i) => {
      const even = Math.round(P.x - o.w / 2 + (o.w * (i + 1)) / (ps.length + 1));
      const walls = L.pos.filter((K, k) => k !== p && k !== a && K.y + o.h > bar(p) && K.y < P.y).map((K) => [K.x - o.w / 2 - 4, K.x + o.w / 2 + 4]);
      const w = want(p, a);
      const under = w != null && w >= lo && w <= hi ? [w] : [];
      return [...under, even, lo, hi, ...walls.flat().filter((x) => x > lo && x < hi)].map((x, k) => ({ x, cost: (k < under.length ? -o.w : Math.abs(x - even)) + (walls.some(([l, r]) => l < x && x < r) ? 1000 : 0) }));
    });
    // 从左到右依次选、相邻至少隔 gap，总罚分最小（动态规划；全用均分点总是选得出来）
    let paths = [{ x: -Infinity, cost: 0, xs: [] }];
    for (const cs of cands)
      paths = cs.flatMap((c) => {
        const ok = paths.filter((t) => c.x >= t.x + gap);
        if (!ok.length) return [];
        const t = cheapest(ok);
        return [{ x: c.x, cost: t.cost + c.cost, xs: [...t.xs, c.x] }];
      });
    const pick = cheapest(paths).xs;
    ps.forEach((p, i) => {
      groups.get(p).push({ from: a, x: pick[i], top: P.y });
      if (ings.get(p).length === 1 && pick[i] === want(p, a)) stem.set(p, pick[i]);
    });
  }
  return [...groups].map(([b, drops]) => ({ to: b, px: stem.get(b) ?? L.pos[b].x, bottom: L.pos[b].y + o.h, bar: bar(b), drops }));
}
/**
 * 依赖图连线的交叉（纯函数）：crossings 是相交的线的对数——不同产物的两条线（产物 → 原料），一条的横段穿过另一条的竖段、或两条竖线叠在一起；
 * passes 是竖线从别的卡片（不是它两头的）后面穿过去的次数
 */
function graphCrossings(G, L, o = GRAPH) {
  // 每条线：横段 y、x1–x2，产物底下那一小段竖线 (px, y0–y)，落到原料的竖线 (dx, d0–d1)
  const ls = [];
  for (const r of graphRoutes(G, L, o))
    for (const q of r.drops) ls.push({ p: r.to, c: q.from, y: r.bar, x1: Math.min(r.px, q.x), x2: Math.max(r.px, q.x), px: r.px, y0: r.bottom, dx: q.x, d0: Math.min(r.bar, q.top), d1: Math.max(r.bar, q.top) });
  const cross = (a, b) => (a.x1 < b.px && b.px < a.x2 && b.y0 < a.y && a.y < b.y) || (a.x1 < b.dx && b.dx < a.x2 && b.d0 < a.y && a.y < b.d1);
  const stack = (x, lo, hi, b) => (x === b.px && Math.max(lo, b.y0) < Math.min(hi, b.y)) || (x === b.dx && Math.max(lo, b.d0) < Math.min(hi, b.d1));
  let crossings = 0;
  for (let i = 0; i < ls.length; i++)
    for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i];
      const b = ls[j];
      if (a.p !== b.p && (cross(a, b) || cross(b, a) || stack(a.px, a.y0, a.y, b) || stack(a.dx, a.d0, a.d1, b))) crossings++;
    }
  // 产物底下那一小段在连线区里，碰不到卡片；只数落到原料的竖线
  let passes = 0;
  for (const a of ls) L.pos.forEach((P, k) => (passes += k !== a.p && k !== a.c && Math.abs(a.dx - P.x) < o.w / 2 && a.d0 < P.y + o.h && P.y < a.d1));
  return { crossings, passes };
}
/**
 * 依赖图的连线（SVG，铺在卡片下面）：走法见 graphRoutes，都是直角细线；产物底边中点一个朝上的小实心三角（原料往上送进产物），
 * 进外部供应卡片的那段竖线是虚线，副产物的线整条是点线，跨层的竖线找不到空当时从中间层的卡片后面穿过去。横线在产物中心和各落点处切开，
 * 每段都记下连着谁（data-to 是产物，data-from 是这段通往的原料），悬停时只亮连着高亮卡片的
 */
function graphLinks(G, L, o = GRAPH) {
  const id = (k) => G.nodes[k].id;
  const seg = (to, from, d, cls) => `<path class="ln${cls ? ` ${cls}` : ''}" data-to="${id(to)}" data-from="${from.map(id).join(' ')}" d="${d}"/>`;
  const byKey = new Set(G.edges.filter((e) => e.state === 'by').map((e) => `${e.from}>${e.to}`)); // 副产物、同一组工厂一起出的
  let s = '';
  for (const r of graphRoutes(G, L, o)) {
    const all = r.drops.map((q) => q.from);
    const by = r.drops.every((q) => byKey.has(`${id(q.from)}>${id(r.to)}`)) ? 'by' : '';
    s += `<path class="ar" data-to="${id(r.to)}" data-from="${all.map(id).join(' ')}" d="M${r.px} ${r.bottom + 1}l4 6h-8z"/>`;
    s += seg(r.to, all, `M${r.px} ${r.bottom + 7}V${r.bar}`, by);
    const xs = [...new Set([r.px, ...r.drops.map((q) => q.x)])].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const [a, b] = [xs[i - 1], xs[i]];
      s += seg(r.to, r.drops.filter((q) => (b <= r.px ? q.x <= a : q.x >= b)).map((q) => q.from), `M${a} ${r.bar}H${b}`, by);
    }
    for (const q of r.drops) s += seg(r.to, [q.from], `M${q.x} ${r.bar}V${q.top}`, by || (G.nodes[q.from].state === 'external' ? 'ext' : ''));
  }
  return s;
}
function renderExt() {
  const d = chainData;
  if (!d) return;
  $('ext-title').textContent = `外部供应：${d.title}`;
  const goalIds = new Set(d.goals.map((g) => g.id));
  const G = (extG = extGraph(d));
  const names = new Map(G.nodes.map((u) => [u.id, u.name]));
  const usesOf = (id) => G.edges.filter((e) => e.from === id && e.state !== 'by').map((e) => names.get(e.to));
  const byOf = (id) => G.edges.filter((e) => e.from === id && e.state === 'by').map((e) => `${names.get(e.to)} ${fmt(e.rate)}/分`);
  // 一张卡：左边图标，右边物品名和一行小字（目标：出多少、几台；产线里的：多少、几台；外部供应：多少；排不了：需要什么设备；
  // 原料：原矿、黑雾掉落或由外部供给多少；副产物：多少），量都是总量。原料、副产物点了不变
  const card = (u) => {
    const isGoal = goalIds.has(u.id);
    const blocking = d.blocking.includes(u.name);
    const fixed = isGoal || u.state === 'raw' || u.state === 'by';
    const co = u.state === 'line' && u.co != null; // 和另一种物品同一组工厂出、也供产线（石墨烯、氢都选了石墨烯（高效））
    const tag = u.state === 'raw' ? rawTag(u) : u.state === 'by' || co ? '副产' : '';
    const cls = ['xt', isGoal && 'is-goal', u.state === 'external' && 'is-ext', u.state === 'raw' && 'is-raw', u.state === 'by' && 'is-by', co && 'is-co', blocking && 'is-blocking'].filter(Boolean).join(' ');
    const n = u.levels ? `${u.count} 叠×${u.levels} 层` : `${u.count} 台`;
    const sub = isGoal ? `出 ${fmt(u.out)}/分，${n}` : blocking ? `需要${u.factory}` : u.state === 'line' && !co ? `${fmt(u.rate)}/分，${n}` : `${fmt(u.rate)}/分`;
    const uses = usesOf(u.id);
    const by = byOf(u.id);
    const left = (d.surplus || []).find((x) => x.id === u.id);
    const usesTxt = (uses.length ? `，用于 ${uses.join('、')}` : '') + (by.length ? `，副产 ${by.join('、')}` : '') + (left ? `，其中 ${fmt(left.rate)}/分用不完、跟着这条带送出` : '');
    const tip = isGoal
      ? `${u.name}：最终目标，${u.factory} ${n}${usesTxt}`
      : blocking
        ? `${u.name}：需要${u.factory}，目前排不了，请设为外部供应${usesTxt}`
        : u.state === 'external'
          ? `${u.name}：外部供应 ${fmt(u.rate)}/分${usesTxt}。点击改回在产线里生产`
          : u.state === 'raw'
            ? `${u.name}：${tag} ${fmt(u.rate)}/分${usesTxt}`
            : u.state === 'by'
              ? `${u.name}：${G.edges.filter((e) => e.to === u.id).map((e) => names.get(e.from)).join('、')}那组工厂的副产物 ${fmt(u.rate)}/分，单独一条带送出产线`
              : co
                ? `${u.name}：和${names.get(u.co)}同一组工厂出（${u.factory} ${n}）${fmt(u.rate)}/分${usesTxt}。点击设为外部供应`
                : `${u.name}：${u.factory} ${n}，${fmt(u.rate)}/分${usesTxt}。点击设为外部供应`;
    return `<button type="button" class="${cls}" style="--cat:${CAT_COLOR[u.type] || '#9aa5b1'}" data-id="${u.id}" data-name="${esc(u.name)}" title="${esc(tip)}" aria-pressed="${u.state === 'external'}"${fixed ? ' aria-disabled="true"' : ''}>${pic(u)}<span class="nm">${esc(u.name)}</span><span class="sub"${tag ? ` data-tag="${tag}"` : ''}>${esc(sub)}</span></button>`;
  };
  const box = $('tiers');
  const old = box.querySelector('.tree-canvas');
  const view = old && { left: old.scrollLeft, top: old.scrollTop };
  // 点一张卡会重画整张图：键盘焦点在哪种物品上，重画后放回去
  const was = box.contains(document.activeElement) ? document.activeElement.closest('.xt[data-id]')?.dataset.id : null;
  const keep = extFocus;
  box.innerHTML = `<div class="tree-canvas"><div class="tree-zoom"><div class="tree-stage"><svg class="tree-links" aria-hidden="true"></svg>${G.nodes.map(card).join('')}</div></div></div>${ZOOM_TOOLS}`;
  const raws = d.raws.map((r) => `${esc(r.name)} ${fmt(r.rate)}/分`).join('、');
  const ext = d.units.filter((u) => u.state === 'external').map((u) => u.name); // 设了外部供应、可现在没人用的不算
  $('ext-foot').innerHTML = d.blocking.length
    ? `<span class="warn">${esc(d.blocking.join('、'))} 需要原油精炼厂等，产线排不了。${
        d.suggested.length ? `建议把 ${esc(d.suggested.join('、'))} 设为外部供应，点「按建议设置」即可。` : '请把它们设为外部供应。'
      }</span>`
    : `由外部供给：${ext.length ? `${esc(ext.join('、'))}（外部供应），` : ''}${raws || '无'}。`;
  if (d.byproducts?.length) $('ext-foot').innerHTML += ` 副产：${d.byproducts.map((b) => `${esc(b.name)} ${fmt(b.rate)}/分（${esc(b.of)}）单独一条带送出`).join('、')}。`;
  if (d.surplus?.length) $('ext-foot').innerHTML += ` 用不完：${d.surplus.map((x) => `${esc(x.name)} ${fmt(x.rate)}/分`).join('、')}，跟着那条带送出。`;
  $('ext-foot').dataset.base = $('ext-foot').innerHTML;
  $('ext-suggest').hidden = !d.suggested.some((n) => !state.ext.has(n));
  renderRecipes(d);
  // 卡高按实际量（字体不同会差一两像素）；弹窗没打开时量不到，按默认的算（打开时会重画）
  const cv = box.firstElementChild;
  const wrap = cv.firstElementChild;
  const stage = wrap.firstElementChild;
  const els = [...stage.querySelectorAll('.xt')];
  const o = { ...GRAPH, h: Math.max(0, ...els.map((el) => el.offsetHeight)) || GRAPH.h };
  const L = layoutGraph(G, o);
  // 布局按产物在上算的，这里上下翻过来：最终产物在最下面
  els.forEach((el, k) => {
    el.style.left = `${L.pos[k].x - o.w / 2}px`;
    el.style.top = `${L.height - L.pos[k].y - o.h}px`;
  });
  stage.style.width = `${L.width}px`;
  stage.style.height = `${L.height}px`;
  stage.firstElementChild.innerHTML = `<g transform="matrix(1 0 0 -1 0 ${L.height})">${graphLinks(G, L, o)}</g>`;
  // 画布高度按 100% 时的图定（最高 min(62vh, 640px)），缩放时不跟着变
  cv.style.height = `${L.height + cv.offsetHeight - cv.clientHeight}px`;
  sizeZoom(cv);
  // 滚动：点了哪张卡就让它留在屏幕原处（图变了，别的卡会挪），别的原因重画就保持原来的滚动，刚打开时把第一个目标（最下面）放到中间
  const anchor = extAnchor;
  extAnchor = null;
  const hit = anchor && stage.querySelector(`.xt[data-id="${anchor.id}"]`);
  if (hit) {
    cv.scrollLeft = wrap.offsetLeft + hit.offsetLeft * extZoom - anchor.x;
    cv.scrollTop = wrap.offsetTop + hit.offsetTop * extZoom - anchor.y;
  } else if (view) {
    cv.scrollLeft = view.left;
    cv.scrollTop = view.top;
  } else {
    cv.scrollLeft = wrap.offsetLeft + L.pos[0].x * extZoom - cv.clientWidth / 2;
    cv.scrollTop = cv.scrollHeight;
  }
  if (was) stage.querySelector(`.xt[data-id="${was}"]`)?.focus({ preventScroll: true });
  focusItem(keep);
}

// 画布右边一列（用户 2026/10/27）：珍奇和原矿在前，一种一张卡，和画布里的卡一样大：左边图标、右边名字，下面一行小字「用于 物品」；只能整种开关。
//   珍奇矿物（光栅石、刺笋结晶…）：点一下，用这种矿的新配方全开（卡西米尔晶体、光子合并器都用光栅石，就一起开），全开着时全关；
//   有机晶体（有矿脉，当珍奇）、氢、重氢（气态巨星的轨道采集器）、硫酸（硫酸海）当原矿：点一下设成外部供应，再点改回在产线里做。
// 后面是不用珍奇的新配方（空间翘曲器（高级），重氢是目标时的重氢分馏），写配方名，图标是它特有的原料，下面一行配方
const RAW_LIKE = [1117, 1120, 1121, 1116]; // 有机晶体、氢、重氢、硫酸
const FRAC_RECIPE = 115; // 重氢分馏（分馏塔阵列），worker.js
function recipeGroups(d) {
  const goals = new Set(d.goals.map((g) => g.id));
  const groups = new Map();
  for (const x of d.recipes || [])
    for (const a of x.alts) {
      if (a.id === FRAC_RECIPE && !goals.has(x.id)) continue; // 重氢不是目标时分馏就是让重氢走外部供应，用「重氢」那张卡
      const key = a.ore ? `ore${a.ore.id}` : `r${a.id}`;
      if (!groups.has(key)) groups.set(key, { ore: a.ore, icon: a.key, name: a.ore ? a.ore.name : a.name, line: a.line, uses: [] });
      groups.get(key).uses.push({ item: x.id, name: x.name, recipe: a.id, recipeName: a.name, line: a.line, def: x.def, on: x.chosen === a.id });
    }
  return [...groups.values()];
}
function renderRecipes(d) {
  const box = $('ext-recipes');
  const groups = recipeGroups(d);
  const live = (id) => d.edges.filter((e) => e.from === id && e.state !== 'dropped').map((e) => e.to);
  const raws = RAW_LIKE.map((id) => d.units.find((u) => u.id === id && u.state !== 'dropped')).filter(Boolean);
  if (!groups.length && !raws.length) {
    box.hidden = true;
    return (box.innerHTML = '');
  }
  box.hidden = false;
  const icon = (x) => (x ? pic(byId.get(x.id) ?? { name: x.name }) : '');
  const names = new Map([...d.goals, ...d.units].map((u) => [u.id, u.name]));
  const users = (ids) => `<span class="rc-for">${ids.length ? `用于 ${esc([...new Set(ids)].map((id) => names.get(id) ?? byId.get(id)?.name ?? '').join('、'))}` : ''}</span>`;
  const card = (attrs, on, tip, x, name, body) => `<button type="button" class="rc${on ? ' is-on' : ''}" style="--cat:${CAT_COLOR[byId.get(x?.id)?.type] || '#9aa5b1'}" ${attrs} aria-pressed="${on}" title="${esc(tip)}"><span class="rc-ico">${icon(x)}</span><span class="rc-name">${esc(name)}</span><span class="rc-state">${on ? '已开启' : ''}</span>${body}</button>`;
  const ores = groups.filter((g) => g.ore);
  const recipes = groups.filter((g) => !g.ore);
  const recipeCard = (g) => {
    const on = g.uses.every((u) => u.on);
    const what = g.uses.map((u) => `${u.name}改用「${u.recipeName}」（${u.line}）`).join('；');
    return card(`data-uses="${g.uses.map((u) => `${u.item}:${u.recipe}`).join(',')}"`, on, `${g.ore ? `${g.name}：` : ''}${what}。点击${on ? '改回默认配方' : '开启'}`, g.icon, g.name, g.ore ? users(g.uses.map((u) => u.item)) : `<span class="rc-line">${esc(g.line)}</span>`);
  };
  const rawCard = (u) => {
    const on = u.state === 'external';
    const uses = live(u.id);
    const used = uses.length ? `，用于 ${uses.map((id) => names.get(id)).join('、')}` : '';
    return card(`data-ext="${esc(u.name)}"`, on, `${u.name}：${on ? '当原矿，由外部供给' : '现在在产线里做'}${used}。点击${on ? '改回在产线里做' : '当原矿，由外部供给'}`, u, u.name, users(uses));
  };
  const top = [...ores.map(recipeCard), ...raws.map(rawCard)];
  box.innerHTML =
    (top.length ? `<h3>珍奇和原矿</h3><div class="rc-list">${top.join('')}</div>` : '') +
    (recipes.length ? `<h3>新配方</h3><div class="rc-list">${recipes.map(recipeCard).join('')}</div>` : '');
}
$('ext-recipes').addEventListener('click', (e) => {
  const b = e.target.closest('button.rc');
  if (!b) return;
  if (b.dataset.ext != null) {
    // 原矿那几样：设成 / 取消外部供应；重氢开着分馏（不是目标时就是外部供应）的，关掉时一起关
    const name = b.dataset.ext;
    const on = b.getAttribute('aria-pressed') === 'true';
    if (on) {
      state.ext.delete(name);
      if (name === '重氢' && Number(state.recipes[1121]) === FRAC_RECIPE) delete state.recipes[1121];
    } else state.ext.add(name);
    $('suggest').hidden = true;
  } else {
    // 珍奇和新配方：这几样都开着就都关掉，不然都开
    const pairs = b.dataset.uses.split(',').map((p) => p.split(':').map(Number));
    const allOn = pairs.every(([item, r]) => Number(state.recipes[item]) === r);
    for (const [item, r] of pairs) {
      if (allOn) delete state.recipes[item];
      else state.recipes[item] = r;
    }
  }
  saveSettings();
  renderSpec();
  requestChain();
});

// 悬停或聚焦一张卡：它和直接相连的卡（用它的产物、它的原料）亮着、别的淡下去，连着它的线变实色（画到最上面）、别的线淡下去，
// 底部列出它供给谁、由谁供给；图里已经没有它（重画后）就恢复
function focusItem(id) {
  const d = chainData;
  const box = $('tiers');
  if (!d || !box) return;
  const cards = [...box.querySelectorAll('.xt[data-id]')];
  if (!cards.some((el) => Number(el.dataset.id) === id)) id = null;
  extFocus = id;
  box.classList.toggle('has-focus', id != null);
  const live = extG?.edges ?? [];
  const near = new Set(id == null ? [] : [id, ...live.filter((e) => e.from === id).map((e) => e.to), ...live.filter((e) => e.to === id).map((e) => e.from)]);
  cards.forEach((el) => el.classList.toggle('near', near.has(Number(el.dataset.id))));
  const svg = box.querySelector('.tree-links');
  svg?.querySelectorAll('[data-to]').forEach((p) => p.classList.toggle('on', id != null && (Number(p.dataset.to) === id || p.dataset.from.split(' ').some((f) => Number(f) === id))));
  if (id != null) svg?.firstElementChild?.append(...svg.querySelectorAll('.on')); // 挪到最上面，留在上下翻转的那一组里
  const foot = $('ext-foot');
  if (id == null) {
    foot.innerHTML = foot.dataset.base || '';
    return;
  }
  const names = new Map(extG.nodes.map((u) => [u.id, u.name]));
  const down = live.filter((e) => e.from === id).map((e) => (e.via ? `${esc(names.get(e.to))}（同一组）` : `${esc(names.get(e.to))}${e.state === 'by' ? '（副产）' : ''} ${fmt(e.rate)}/分`));
  const up = live.filter((e) => e.to === id && e.state !== 'by').map((e) => esc(names.get(e.from)));
  const with_ = live.filter((e) => e.to === id && e.state === 'by').map((e) => esc(names.get(e.from))); // 出它的那组工厂（副产物、同组一起出的）
  const node = extG.nodes.find((u) => u.id === id);
  foot.innerHTML =
    node?.state === 'by'
      ? `<b>${esc(node.name)}</b>：${with_.join('、')}那组工厂的副产物 ${fmt(node.rate)}/分，单独一条带送出产线`
      : `<b>${esc(names.get(id))}</b>${down.length ? ` → ${down.join('、')}` : ''}${with_.length ? `；和${with_.join('、')}同一组工厂出` : ''}${up.length ? `；原料来自 ${up.join('、')}` : node?.state === 'raw' ? `；${rawTag(node)}` : ''}`;
}
// 卡片之间的空处不算离开（不然鼠标移动时一闪一闪），移出整个画布才恢复
for (const ev of ['mouseover', 'focusin'])
  $('tiers').addEventListener(ev, (e) => {
    const b = e.target.closest('.xt[data-id]');
    if (b && Number(b.dataset.id) !== extFocus) focusItem(Number(b.dataset.id));
  });
$('tiers').addEventListener('mouseleave', () => focusItem(null));
// 拖动画布：鼠标左键按住拖着看，移过 4 像素才算拖，松手时的那次 click 不算点；触摸、触控板滑动交给浏览器自己滚
let pan = null;
let panClick = false;
$('tiers').addEventListener('pointerdown', (e) => {
  const cv = e.target.closest('.tree-canvas');
  if (e.pointerType !== 'mouse' || e.button !== 0 || !cv) return;
  // 图比画布窄时两边的空白处也能拖；点在滚动条上的不管
  const r = cv.getBoundingClientRect();
  if (!e.target.closest('.tree-stage') && (e.clientX - r.left - cv.clientLeft >= cv.clientWidth || e.clientY - r.top - cv.clientTop >= cv.clientHeight)) return;
  panClick = false;
  pan = { cv, id: e.pointerId, x: e.clientX, y: e.clientY, left: cv.scrollLeft, top: cv.scrollTop, moved: false };
});
$('tiers').addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  if (!(e.buttons & 1)) return endPan(e); // 在别处松的手
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (!pan.moved) {
    if (Math.hypot(dx, dy) <= 4) return;
    pan.moved = true;
    pan.cv.setPointerCapture(e.pointerId);
    pan.cv.classList.add('is-panning');
  }
  pan.cv.scrollLeft = pan.left - dx;
  pan.cv.scrollTop = pan.top - dy;
});
function endPan(e) {
  if (!pan || e.pointerId !== pan.id) return;
  if (pan.moved) {
    pan.cv.classList.remove('is-panning');
    panClick = true;
    setTimeout(() => (panClick = false)); // 松手后紧跟着的 click 在这之前派发
  }
  pan = null;
}
$('tiers').addEventListener('pointerup', endPan);
$('tiers').addEventListener('pointercancel', endPan);
$('tiers').addEventListener('dragstart', (e) => e.preventDefault()); // 图标图片不要被拖走
// 记下被点的卡在画布可视区里的位置，重画后让它留在原处
function anchorOf(b) {
  const cv = b.closest('.tree-canvas');
  const wrap = cv.firstElementChild;
  return { id: b.dataset.id, x: wrap.offsetLeft + b.offsetLeft * extZoom - cv.scrollLeft, y: wrap.offsetTop + b.offsetTop * extZoom - cv.scrollTop };
}

// 画布缩放（用户 2026/10/27）：触控板两指捏合、按住 ⌘ / Ctrl 滚滚轮，以指针处为中心；画布右上角「− 100% + 全图」，点百分比回到 100%，
// 「全图」缩到整张图放得下；画布里按 + − 0 也行。30%~150%，关了弹窗再开还是上次的比例。不按键的滚轮照旧滚动、按住拖照旧平移。
// 卡片和连线照旧按原尺寸排，缩放的是外面一层（tree-zoom 按缩放后的大小占位，好让滚动条对得上）
const ZOOM_STEPS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const ZOOM_TOOLS = '<div class="tree-tools" role="group" aria-label="缩放画布"><button type="button" data-tree-zoom="out" aria-label="缩小" title="缩小">−</button><button type="button" data-tree-zoom="reset" class="zoom-pct" title="回到 100%">100%</button><button type="button" data-tree-zoom="in" aria-label="放大" title="放大">+</button><button type="button" data-tree-zoom="fit" title="缩到整张图放得下">全图</button></div>';
let extZoom = 1;
/** 按 extZoom 设缩放：外层占缩放后的大小，里面的图整个缩放 */
function sizeZoom(cv) {
  const wrap = cv.firstElementChild;
  const stage = wrap.firstElementChild;
  wrap.style.width = `${parseFloat(stage.style.width) * extZoom}px`;
  wrap.style.height = `${parseFloat(stage.style.height) * extZoom}px`;
  stage.style.transform = extZoom === 1 ? '' : `scale(${extZoom})`;
  const pct = cv.parentElement.querySelector('.zoom-pct');
  if (pct) pct.textContent = `${Math.round(extZoom * 100)}%`;
}
/** 缩放到 z，画布可视区里 (fx, fy) 这一点下面的图不动（不给就是可视区中心） */
function zoomExt(z, fx, fy) {
  const cv = $('tiers').querySelector('.tree-canvas');
  if (!cv) return;
  const wrap = cv.firstElementChild;
  z = Math.min(ZOOM_STEPS.at(-1), Math.max(ZOOM_STEPS[0], z));
  fx ??= cv.clientWidth / 2;
  fy ??= cv.clientHeight / 2;
  const x = (cv.scrollLeft + fx - wrap.offsetLeft) / extZoom;
  const y = (cv.scrollTop + fy - wrap.offsetTop) / extZoom;
  extZoom = z;
  sizeZoom(cv);
  cv.scrollLeft = wrap.offsetLeft + x * z - fx;
  cv.scrollTop = wrap.offsetTop + y * z - fy;
}
/** 按档位往大（dir 1）或往小（−1）走一档 */
const stepZoom = (dir, fx, fy) => zoomExt(dir > 0 ? ZOOM_STEPS.find((z) => z > extZoom + 1e-6) ?? ZOOM_STEPS.at(-1) : ZOOM_STEPS.findLast((z) => z < extZoom - 1e-6) ?? ZOOM_STEPS[0], fx, fy);
$('tiers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tree-zoom]');
  if (!b) return;
  const how = b.dataset.treeZoom;
  if (how === 'in' || how === 'out') return stepZoom(how === 'in' ? 1 : -1);
  if (how === 'reset') return zoomExt(1);
  const cv = $('tiers').querySelector('.tree-canvas');
  const stage = cv.firstElementChild.firstElementChild;
  zoomExt(Math.min(1, cv.clientWidth / parseFloat(stage.style.width), cv.clientHeight / parseFloat(stage.style.height)));
  cv.scrollLeft = 0;
  cv.scrollTop = cv.scrollHeight;
});
// 指针在画布可视区里的位置
const canvasPoint = (cv, e) => {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left - cv.clientLeft, e.clientY - r.top - cv.clientTop];
};
let pinch = null; // Safari 的触控板捏合（gesture 事件）：开始时的缩放
$('tiers').addEventListener(
  'wheel',
  (e) => {
    const cv = e.target.closest('.tree-canvas');
    if (!cv || !(e.ctrlKey || e.metaKey) || pinch != null) return;
    e.preventDefault(); // 不让浏览器整页缩放
    const [fx, fy] = canvasPoint(cv, e);
    // 鼠标滚轮一格（deltaY 几十上百）走一档，触控板捏合（每次几个像素）连续缩放
    if (e.deltaMode || Math.abs(e.deltaY) >= 50) stepZoom(-Math.sign(e.deltaY), fx, fy);
    else zoomExt(extZoom * Math.exp(-e.deltaY * 0.01), fx, fy);
  },
  { passive: false },
);
$('tiers').addEventListener('gesturestart', (e) => {
  if (!e.target.closest?.('.tree-canvas')) return;
  e.preventDefault();
  pinch = extZoom;
});
$('tiers').addEventListener('gesturechange', (e) => {
  if (pinch == null) return;
  e.preventDefault();
  const cv = $('tiers').querySelector('.tree-canvas');
  zoomExt(pinch * e.scale, ...canvasPoint(cv, e));
});
$('tiers').addEventListener('gestureend', () => (pinch = null));
$('tiers').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !e.target.closest('.tree-canvas, .tree-tools')) return;
  if (e.key === '+' || e.key === '=') stepZoom(1);
  else if (e.key === '-' || e.key === '_') stepZoom(-1);
  else if (e.key === '0') zoomExt(1);
  else return;
  e.preventDefault();
});
$('tiers').addEventListener('click', (e) => {
  if (panClick) return;
  const b = e.target.closest('.xt');
  if (!b || b.getAttribute('aria-disabled') === 'true') return;
  const name = b.dataset.name;
  if (state.ext.has(name)) state.ext.delete(name);
  else state.ext.add(name);
  extAnchor = anchorOf(b);
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
  renderExtChips();
  renderMore();
}
/**
 * 左栏「外部供应」那一栏：外部供应的物品，开了新配方的物品也列在这里（在弹窗底部开关）。
 * 以前目标用过的外部供应、新配方只在当前产线用得上时显示（用户 2026/10/26：堆太多），按后台预告的 chainItems 筛；
 * 看不见的照样记着，目标又用上时再出来。预告算不出产线（chainItems 为空）时全列
 */
function renderExtChips() {
  // 第一份预告回来之前（刚打开页面）先不列，免得先列出一堆、再收掉；目标还没选好（不发预告）时照旧全列
  if (!forecastData && catalog.length && state.targets.every((t) => byId.get(t.id))) return ($('ext-list').innerHTML = '');
  const inChain = forecastData?.chainItems ? new Set(forecastData.chainItems) : null;
  const used = forecastData?.supplied ? new Set(forecastData.supplied) : null; // 设了外部供应、可现在没人用的（只有硫酸用精炼油、硫酸也设了）不列
  const ext = [...state.ext].filter((n) => (!inChain || inChain.has(catalog.find((c) => c.name === n)?.id)) && (!used || used.has(n)));
  const alts = Object.keys(state.recipes)
    .filter((id) => !inChain || inChain.has(Number(id)))
    .map((id) => byId.get(Number(id)))
    .filter(Boolean)
    .map((x) => `<li class="rc-on">${pic(x)}${esc(x.name)}：新配方<button type="button" data-recipe-off="${x.id}" aria-label="${esc(x.name)} 改回默认配方">×</button></li>`);
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
}
// 折叠起来的「集装」「物流站格子」在标题上显示当前取值
function renderMore() {
  // 左栏的分组都不再折叠（用户 2026/10/26），没有摘要要写了；留着这个名字，调用处不动
}
// 长宽比上限和宽度、长度上限容易打架：开了长宽比，宽、长回到不限；开了宽或长，长宽比回到不限
$('spec').addEventListener('change', (e) => {
  const name = e.target?.name;
  if (!['aspect', 'maxwidth', 'maxheight'].includes(name)) return;
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
  const boxed = !connected && !!document.querySelector('input[name="supply"]:checked')?.value; // 「物流方式」选了传送带+箱子
  $('pile-field').hidden = !connected;
  $('supply-field').hidden = !boxed; // 箱子（左侧一列仓组）的大小只在传送带+箱子时有
  $('dist-field').hidden = !boxed; // 物流配送器：同上
  $('proslot-field').hidden = !connected; // 物流站格子（增产剂格、翘曲器格）只在接物流站时有意义
  $('warper-field').hidden = !connected;
  const select = $('pile-field').querySelector('select');
  if (select) {
    select.disabled = !connected;
    select.title = connected ? '物流站输出堆叠层数，取决于已解锁科技' : '接入物流站后可设置';
  }
}
document.querySelectorAll('input[name="station"], input[name="supply"]').forEach((el) => el.addEventListener('change', togglePile));
$('ext-list').addEventListener('click', (e) => {
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
  $('cancel').hidden = !on;
  $('like').disabled = on || likedThis; // 搜索中点不了赞
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
// 取消本轮生成（用户 2026/10/26，代替原来的「就这个蓝图了」）：后台停掉帮手线程，这一次的结果不再要；编号加一，迟到的进度、结果都不认
$('cancel').addEventListener('click', () => {
  if (!busy) return;
  send({ type: 'cancel', id: reqId });
  reqId++;
  setBusy(false);
  setStatus('已取消本轮生成。');
});

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
}
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

/** 页面设置 → 后台的 params（生成和预告共用；生成时另加 again） */
function buildParams() {
  const params = { targets: state.targets.map((t) => ({ target: t.id, rate: t.rate })), raw: [...state.ext], recipes: { ...state.recipes } };
  for (const name of OPTION_NAMES) params[name] = state[name];
  params.stationPrefs = state.stationPrefs; // 翘曲器格、增产剂格改过的设置（物流站简介里改的，出蓝图照这个设）
  params.orient = 'h';
  params.labstack = state.labstack;
  return params;
}
// 选完目标、改了选项就立刻算建筑数、预计用时、用电（用户 2026/10/26），写在「生成蓝图」下面；攒 250 毫秒再问，免得每敲一个数字问一次
function requestForecast() {
  if (!catalog.length || !state.targets.every((t) => byId.get(t.id))) return;
  clearTimeout(forecastTimer);
  forecastTimer = setTimeout(() => send({ type: 'forecast', id: ++forecastId, params: buildParams() }), 250);
}
/** 「生成蓝图」下面那一行：建筑几台（最多列 4 种工厂）、预计用时（分馏塔阵列不用搜，不写）、工厂满负荷用电；只动这一行，不碰目标的输入框 */
function renderForecast() {
  const d = forecastData;
  if (!d || d.error || !d.machines) return ($('forecast').textContent = '');
  const kinds = d.byFactory.slice(0, 4).map((f) => `${f.name} ${fmt(f.count)}`).join('、') + (d.byFactory.length > 4 ? ' 等' : '');
  const rest = [d.seconds > 0 ? `预计约 ${Math.ceil(d.seconds)} 秒` : '', `工厂满负荷约 ${d.power.maxText}`].filter(Boolean);
  $('forecast').textContent = `建筑 ${fmt(d.machines)} 台（${kinds}）· ${rest.join(' · ')}`;
}
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
  const params = buildParams();
  // 同样的输入再点一次换一个种子（用户 2026/10/24：对这个方案不满意，再点就换一个）；改了输入再回来也接着换，不重复
  const key = JSON.stringify(params);
  params.again = presses.get(key) ?? 0;
  presses.set(key, params.again + 1);
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
  resetLike(); // 一次生成点一次赞
  show(d);
  goalNote(d.goal);
}

/**
 * 没达到这一档的利用率（用户 2026/10/07 改：照常显示搜到的最好那张）：状态栏后面补一句。
 * 连续几段没进步就先停了（stalled，同日用户要的「没进展就停」），不然是到了时间上限。不可行、检查没过 show 已经说了
 */
function goalNote(g) {
  if (!g || g.met || g.space >= g.target) return;
  if (g.feasible) console.info(`[dsp-handcraft] 利用率 ${Math.round(g.space * 100)}%，没到这一档的 ${Math.round(g.target * 100)}%${g.stalled ? '（连续几段没进步，先停了）' : ''}`);
}

/** 把一张图的结果画出来 */
function show(d) {
  last = d;
  floors = sliceRoutes(d.model.routes);
  view.level = 'all'; // 出图先看总览（地面实线、高架虚线叠在一起），要看单层再点右边的 L1、L2…（用户 2026/10/18）
  view.focus = '';
  view.selected = '';
  view.factory = '';
  view.station = null;
  view.machine = null;
  renderStation();
  viewer.reset();
  renderFloorNav(d);
  const secs = (d.ms / 1000).toFixed(1);
  if (d.threads > 1) console.info(`[dsp-handcraft] 用时 ${secs} 秒，${d.threads} 个线程`);
  setStatus(d.feasible && d.check.ok ? `完成，用时 ${secs} 秒。` : `已生成，但有需要注意的地方（见下面「检查」），用时 ${secs} 秒。`, !(d.feasible && d.check.ok));
  $('sheet-name').textContent = d.title ?? `${d.target} ${fmt(d.rate)}/分`;
  fillAlert(d);
  drawSheet(d);
  fillLegend(d);
  fillTitleBlock(d);
  fillPorts(d);
  fillNotes(d);
  fillPowerCard(d.energy);
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
  const tip =
    d.metrics.factories > 120 || d.metrics.stationFallback
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

/** 右侧栏两页：楼层、用电（用户 2026/10/26：用电从「检查」挪过来） */
function railTab(power) {
  $('tab-floors').setAttribute('aria-selected', String(!power));
  $('tab-power').setAttribute('aria-selected', String(power));
  $('floor-list').hidden = power;
  $('power-pane').hidden = !power;
}
$('tab-floors').addEventListener('click', () => railTab(false));
$('tab-power').addEventListener('click', () => railTab(true));

function renderFloorNav(d) {
  $('layer-controls').hidden = false;
  $('layer-rail').hidden = false;
  $('tab-floors').hidden = false;
  railTab(false);
  $('sheet-foot').hidden = false;
  $('result-details').hidden = false;
  $('sheet-tools').querySelectorAll('button').forEach((b) => b.disabled = false);
  const cards = [{ z: 'all', name: '总览' }, ...floors.map((f) => ({ z: f.z, name: `L${f.z + 1}` }))];
  $('floor-list').innerHTML = cards.map((f) => {
    const count = f.z === 'all' ? floors.reduce((n, l) => n + l.cells.size, 0) : floorAt(f.z).cells.size;
    return `<button type="button" class="floor-card" data-floor="${f.z}" aria-pressed="${f.z === view.level}" aria-label="${f.name}，${count} 个带格"><span class="floor-info"><strong>${f.name}</strong><small>${count ? `${count} 格` : '空'}</small></span><span class="floor-thumb">${drawingSvg(d.model, floors, { level: f.z, mini: true, id: `floor-${f.z}` })}</span></button>`;
  }).join('');
}

function drawSheet(d) {
  const box = $('drawing');
  box.classList.add('has-svg');
  const all = view.level === 'all';
  const shown = all ? floors : [floorAt(view.level)];
  const count = shown.reduce((n, f) => n + f.cells.size, 0);
  const name = all ? '总览' : `L${view.level + 1}`;
  $('floor-name').textContent = name;
  // 单层图画了别层接着走的那几段淡虚线（drawing.js 的 linkedRuns）时补一句
  $('floor-description').textContent = all ? '实线地面 · 虚线高架' : `${view.level === 0 ? '地面' : '高架'} · z=${view.level}${linkedRuns(floors, view.level).length ? ' · 虚线：别的层' : ''}`;
  $('floor-meta').textContent = `${d.model.rotated ? d.model.height : d.model.width} × ${d.model.rotated ? d.model.width : d.model.height} 格 · ${count} 带格`;
  box.innerHTML = drawingSvg(d.model, floors, { ...view, label: `${d.title ?? d.target} · ${name} 布线图`, icon: drawIcon });
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
  view.factory = '';
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
  const run = floorAt(z)?.runs[index];
  if (!last || !run) return;
  view.selected = id;
  view.focus = String(run.itemId);
  view.factory = '';
  drawSheet(last);
  $('drawing').focus({ preventScroll: true });
}
/** 单击工厂：简介框（和线路简介同一个）里写它的介绍，就是图上悬停提示那段字；原来选着的线路取消 */
function selectFactory(hint) {
  if (busy || !last) return; // 和点线路一样：搜索预览期间、看整张拼接图时不响应
  view.factory = hint;
  if (!view.selected) return showRouteInfo();
  view.selected = '';
  view.focus = '';
  drawSheet(last); // 去掉线路的高亮，顺带写简介框
}
function clearRoute() {
  $('route-info').hidden = true;
  view.factory = '';
  if (view.station != null || view.machine != null) {
    view.station = null;
    view.machine = null;
    renderStation();
  }
  if (!view.selected) return;
  view.selected = '';
  view.focus = '';
  if (last && !busy) drawSheet(last); // 搜索预览期间别把上一张图画回来
}
// ---------- 物流站简介（用户 2026/10/27，照游戏里星际物流站的面板）：单击图上的站，图纸右上角上面是站口示意，下面存储的 5 格一格一行——
// 物品、上限滑条、右边「本地 / 星际」两个按钮（点一下按 供应 → 需求 → 仓储 轮换），左边一道色条是星际那头的供需；再下面「物流站设置」
// （充能功率、路程、起送量、轨道采集器、翘曲器必备）。改了就让后台改这张蓝图（worker.js 的 patchStation），蓝图字符串跟着换。
// 翘曲器格、增产剂格、整站设置改过的记进设置（state.stationPrefs），以后出蓝图都照这个设（blueprint.js 的 opt.stationPrefs）；整站设置整张图的站一起改。
const ROLE_NAMES = ['仓储', '供应', '需求'];
const NEXT_ROLE = [1, 2, 0]; // 点一下：仓储 → 供应、供应 → 需求、需求 → 仓储
const SPRAY_IDS = [1141, 1142, 1143];
// 站口在站身上的位置（蓝图里朝北摆时，x 右 y 上，中心 ±2；同 emit/check.js 的 STATION_SLOT）：上边 0 1 2 从右到左，左边 3 4 5，下边 6 7 8，右边 9 10 11
const SLOT_AT = { 0: [1, 2], 1: [0, 2], 2: [-1, 2], 3: [-2, 1], 4: [-2, 0], 5: [-2, -1], 6: [-1, -2], 7: [0, -2], 8: [1, -2], 9: [2, -1], 10: [2, 0], 11: [2, 1] };
// 物流站设置：键、名字、滑条范围和步长、显示；运输船最远路程滑到 61 是无限（蓝图里存 10000）
const STATION_SETS = [
  { k: 'workEnergyPerTick', name: '最大充能功率', min: 30, max: 300, step: 1, show: (v) => `${v} MW` },
  { k: 'tripRangeOfDrones', name: '运输机最远路程', min: 20, max: 180, step: 1, show: (v) => `${v}°` },
  { k: 'tripRangeOfShips', name: '运输船最远路程', min: 1, max: 61, step: 1, show: (v) => (v > 60 ? '∞' : `${v} ly`), get: (v) => (v > 60 ? 10000 : v), put: (v) => (v > 60 ? 61 : v) },
  { k: 'warpEnableDistance', name: '曲速启用路程', min: 0.5, max: 60, step: 0.5, show: (v) => `${v} AU` },
  { k: 'deliveryAmountOfDrones', name: '运输机起送量', min: 1, max: 100, step: 1, show: (v) => `${v}%` },
  { k: 'deliveryAmountOfShips', name: '运输船起送量', min: 1, max: 100, step: 1, show: (v) => `${v}%` },
];
const MAX_CAP = 10000; // 上限滑条到 10000（星际站一格的基础容量；比它大的照原值、滑条放宽到 20000）
let patchId = 0;
const patchWaiters = new Map();
let patchChain = Promise.resolve(); // 一次改一处，按顺序来：后一次在前一次改好的字符串上改
function selectStation(k) {
  if (busy || !last?.stationCfg?.[k]) return;
  view.station = k;
  view.machine = null;
  renderStation();
}
// ---------- 工厂小窗（用户 2026/10/27：熔炉、制造台不塞进线路简介框，做成物流站那样的小窗）：单击图上的工厂，图纸右上角写
// 把什么做成什么（原料、产物的图标和数量，每台每分钟多少）、这组几台共多少，这台机器的分拣器示意（带子那头画物品），每根分拣器从哪条带取、
// 放到哪条带，传送带、分拣器是哪一级
function selectMachine(key) {
  if (busy || !last) return;
  view.machine = key;
  view.station = null;
  renderStation();
}
/** 第 ri 行第 gi 组第 i 台：组、中心、占地框，和接在它上面的分拣器（和 drawing.js 的 pivotY 同一个判法） */
function machineOf(key) {
  const [ri, gi, i] = key.split(':').map(Number);
  const row = last?.model.rows[ri];
  const g = row?.groups[gi];
  if (!g?.recipe) return null;
  const cx = g.centers[i];
  const fp = footprint(g);
  const cy = row.cy + fp.dy;
  const box = { x0: cx - fp.w / 2, x1: cx + fp.w / 2, y0: cy - fp.h / 2, y1: cy + fp.h / 2 };
  const sorters = last.model.sorters.filter((so) => so.factoryItem === g.item && so.x >= box.x0 - 0.01 && so.x <= box.x1 + 0.01 && so.y0 >= box.y0 - 0.5 && so.y0 <= box.y1 + 0.5);
  return { g, i, cx, cy, fp, box, sorters };
}
/** 这台机器和它的分拣器：机器框写标号，每根分拣器从框边伸到带子那格，带子那头画物品图标，箭头朝搬的方向；竖排的图跟着转 90° */
function machineDiagram(m, label) {
  const { fp, cx, cy, sorters } = m;
  const ys = sorters.map((so) => so.y1 - cy);
  const top = Math.max(fp.h / 2, ...ys) + 1.1;
  const bottom = Math.min(-fp.h / 2, ...ys) - 1.1;
  const half = Math.max(fp.w / 2, ...sorters.map((so) => Math.abs(so.x - cx))) + 1.1;
  const parts = sorters.map((so) => {
    const x = so.x - cx;
    const edge = so.y1 > so.y0 ? -fp.h / 2 : fp.h / 2; // 画图 y 向下：带子在上面时从框上边出去
    const belt = -(so.y1 - cy);
    const out = so.io === 'out';
    const mid = (edge + belt) / 2;
    const k = Math.sign(out ? belt - edge : edge - belt) || 1;
    const name = byId.get(so.itemId)?.name ?? '';
    return `<g><title>${out ? '出料' : '取料'} · ${esc(name)}</title><path d="M${x} ${edge}V${belt}" stroke="#dbe8f7" stroke-width="0.09"/><path d="M${x - 0.18} ${mid - 0.12 * k}L${x} ${mid + 0.1 * k}L${x + 0.18} ${mid - 0.12 * k}" fill="none" stroke="#dbe8f7" stroke-width="0.08"/><g transform="translate(${x} ${belt}) scale(1.35)">${drawIcon(so.itemId) ?? ''}</g></g>`;
  });
  const W = 2 * half;
  const H = top - bottom;
  return `<svg class="mc-map" viewBox="${-half} ${-top} ${W} ${H}" style="aspect-ratio:${W}/${H}" aria-hidden="true"><g${last.model.rotated ? ' transform="rotate(90)"' : ''}><path d="M${-fp.w / 2} ${-fp.h / 2}h${fp.w}v${fp.h}h${-fp.w}Z" fill="#112f52" stroke="#cfe0f2" stroke-width="0.09"/>${parts.join('')}</g><text y="0.3" text-anchor="middle" font-size="0.85" fill="#e6f0ff" font-weight="500">${esc(label)}</text></svg>`;
}
function renderMachine() {
  const box = $('machine-info');
  const m = view.machine != null && last ? machineOf(view.machine) : null;
  box.hidden = !m;
  if (!m) return;
  const { g, i, sorters } = m;
  const r = g.recipe;
  const no = numberOf(g, i);
  $('machine-title').innerHTML = `${pic(byId.get(g.recipe.outputs[0].id) ?? { name: g.item })}<span>${esc(g.item)}</span><small>${esc(g.letter)}${no}</small>`;
  const tile = (x, rate) => {
    const it = byId.get(x.id) ?? { name: String(x.id) };
    return `<div class="mc-tile" title="${esc(it.name)}"><span class="mc-ico">${pic(it)}<b>×${x.count}</b></span><small>${rate != null ? `${fmt(rate)}/分` : ''}</small></div>`;
  };
  const ins = r.inputs.map((x) => tile(x, x.count * r.crafts)).join('');
  const outs = r.outputs.map((x) => tile(x, x.rate)).join('');
  const main = r.outputs.find((x) => byId.get(x.id)?.name === g.item) ?? r.outputs[0];
  const levels = g.levels > 1 ? `（每叠 ${g.levels} 层）` : '';
  const side = (so) => (so.y1 > so.y0 ? '上边' : '下边');
  const list = sorters
    .slice()
    .sort((a, b) => (a.io === b.io ? a.x - b.x : a.io === 'in' ? -1 : 1))
    .map((so) => {
      const name = byId.get(so.itemId)?.name ?? '';
      return `<li>${pic(byId.get(so.itemId) ?? { name })}<span>${so.io === 'out' ? `放到${side(so)}的 <b>${esc(name)}</b> 带上` : `从${side(so)}的 <b>${esc(name)}</b> 带上取`}</span><small>${so.len ? `长 ${so.len}` : ''}</small></li>`;
    })
    .join('');
  $('machine-body').innerHTML =
    `<p class="mc-sub">${esc(g.factory)} · 这组 ${g.groupCount} 台${levels}</p>` +
    `<div class="mc-recipe">${ins}<span class="mc-arrow">→</span>${outs}</div>` +
    `<p class="mc-sub">${esc(r.name)} · 每次 ${fmt(r.time)} 秒 · 每台出 ${esc(g.item)} <b class="num">${fmt(main.rate ?? 0)}</b>/分，这组共 <b class="num">${fmt((main.rate ?? 0) * g.groupCount)}</b>/分</p>` +
    machineDiagram(m, `${g.letter} ${no}`) +
    `<ul class="mc-list">${list || '<li>没有分拣器</li>'}</ul>` +
    `<p class="st-note">分拣器：${esc(last.parts?.sorter ?? '')} · 传送带：${esc(last.parts?.belt ?? '')}</p>`;
}
/** 这台是同一个标号里的第几台（和图上的编号一样：从上往下一行行、每行从左往右） */
function numberOf(g, i) {
  const all = [];
  for (const row of last.model.rows) for (const x of row.groups) if (x.letter === g.letter) x.centers.forEach((cx, j) => all.push({ x, j, cy: row.cy, cx }));
  all.sort((a, b) => (last.model.rotated ? a.cx - b.cx || a.cy - b.cy : b.cy - a.cy || a.cx - b.cx));
  return all.findIndex((q) => q.x === g && q.j === i) + 1;
}
/** 站口示意图：八角站身，12 个口在四边，接了带子的口画物品图标和箭头（朝外出站、朝里进站）；竖排的图跟着转 90° */
function stationDiagram(cfg) {
  const marks = [];
  cfg.slots.forEach((sl, i) => {
    const it = sl.dir ? cfg.storage[sl.storageIdx - 1]?.itemId : 0;
    const [dx, dy] = SLOT_AT[i];
    const side = Math.abs(dx) === 2 ? [Math.sign(dx), 0] : [0, -Math.sign(dy)]; // 朝外的方向（画图 y 向下）
    const along = Math.abs(dx) === 2 ? [0, -dy * 1.25] : [dx * 1.25, 0];
    const at = (r) => [along[0] + side[0] * r, along[1] + side[1] * r];
    const [ix, iy] = at(3.75);
    if (!it) {
      marks.push(`<circle cx="${ix}" cy="${iy}" r="0.1" fill="#5d7da1"/>`);
      return;
    }
    const out = sl.dir === 1;
    const [ax, ay] = at(out ? 2.95 : 2.65);
    const [bx, by] = at(out ? 2.65 : 2.95);
    const name = byId.get(it)?.name ?? '';
    marks.push(`<g><title>${i + 1} 号口 · ${out ? '出站' : '进站'} · ${esc(name)}</title><path d="M${bx - side[1] * 0.2} ${by - side[0] * 0.2}L${ax} ${ay}L${bx + side[1] * 0.2} ${by + side[0] * 0.2}Z" fill="${out ? '#9ad0f5' : '#ffd166'}"/><g transform="translate(${ix} ${iy}) scale(1.36)">${drawIcon(it) ?? ''}</g></g>`);
  });
  const o = 'M-1.9 -2.5H1.9L2.5 -1.9V1.9L1.9 2.5H-1.9L-2.5 1.9V-1.9Z';
  return `<svg class="st-map" viewBox="-4.6 -4.6 9.2 9.2" aria-hidden="true"><g${last.model.rotated ? ' transform="rotate(90)"' : ''}><path d="${o}" fill="#112f52" stroke="#cfe0f2" stroke-width="0.1"/><circle r="1.5" fill="none" stroke="#7f9fc2" stroke-width="0.05"/>${marks.join('')}</g><text y="0.3" text-anchor="middle" font-size="0.85" fill="#e6f0ff" font-weight="600">T${view.station + 1}</text></svg>`;
}
/** 滑条填色到当前值（和游戏里的条一样左边白） */
const fillSlider = (el) => el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
function renderStation() {
  renderMachine(); // 两个小窗共用一个位置：开着哪个画哪个
  const box = $('station-info');
  const k = view.station;
  const cfg = k != null ? last?.stationCfg?.[k] : null;
  box.hidden = !cfg;
  if (!cfg) return;
  $('station-title').textContent = `物流站 T${k + 1}`;
  const rows = cfg.storage
    .map((x, i) => {
      if (!x.itemId) return '<div class="st-row is-empty"><span class="st-ico"><span class="st-hole"></span></span><span class="st-empty">空栏位</span></div>';
      const it = byId.get(x.itemId) ?? { name: String(x.itemId) };
      const ports = cfg.slots.filter((sl) => sl.dir && sl.storageIdx === i + 1);
      const portTxt = ports.length ? `${ports.length} 个口${ports.every((sl) => sl.dir === 1) ? '出站' : ports.every((sl) => sl.dir === 2) ? '进站' : '进出'}` : '没接带子';
      const keep = x.itemId === 1210 || SPRAY_IDS.includes(x.itemId) ? '<span class="st-keep" title="改了会记住，以后生成的蓝图也这样设">记住</span>' : '';
      const cap = Math.max(MAX_CAP, x.max > MAX_CAP ? 20000 : 0);
      const role = (key, side) => `<button type="button" class="st-role r${x[key]}" data-k="${key}" data-v="${x[key]}" title="点一下换：供应 → 需求 → 仓储">${side}${ROLE_NAMES[x[key]]}</button>`;
      return `<div class="st-row r${x.remoteRole}" data-i="${i}"><span class="st-ico">${pic(it)}</span><div class="st-mid"><div class="st-name"><b>${esc(it.name)}</b><small>${portTxt}</small>${keep}</div><div class="st-cap">上限 <b class="num">${x.max}</b></div><input type="range" class="st-slider" data-k="max" min="0" max="${cap}" step="100" value="${x.max}" aria-label="${esc(it.name)}上限"></div><div class="st-btns">${role('localRole', '本地')}${role('remoteRole', '星际')}</div></div>`;
    })
    .join('');
  const set = cfg.set ?? {};
  const sets = STATION_SETS.filter((d) => set[d.k] != null)
    .map((d) => {
      const v = d.put ? d.put(set[d.k]) : set[d.k];
      return `<label class="st-set-row"><span>${d.name}</span><input type="range" class="st-slider" data-s="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"><b class="num">${d.show(v)}</b></label>`;
    })
    .join('');
  const checks = [['includeOrbitCollector', '轨道采集器'], ['warperNecessary', '翘曲器必备']]
    .filter(([key]) => set[key] != null)
    .map(([key, name]) => `<label class="st-check"><input type="checkbox" data-s="${key}"${set[key] ? ' checked' : ''}>${name}</label>`)
    .join('');
  $('station-body').innerHTML =
    `${stationDiagram(cfg)}<div class="st-rows">${rows}</div>` +
    `<h3 class="st-h">物流站设置<small>整张图的站一起改，会记住</small></h3><div class="st-sets">${sets}<div class="st-checks">${checks}</div></div>` +
    `<p class="st-note">出货叠 ${cfg.pilerCount || 1} 层。改了就写进蓝图字符串。</p>`;
  $('station-body').querySelectorAll('.st-slider').forEach(fillSlider);
}
$('close-station').addEventListener('click', () => {
  view.station = null;
  renderStation();
});
$('close-machine').addEventListener('click', () => {
  view.machine = null;
  renderStation();
});
/** 把改动交给后台改蓝图（排队，一次一处）：storage 第 i 格的新设置，或整站设置 set */
function patchStationOf(d, k, storage, set) {
  patchChain = patchChain
    .then(
      () =>
        new Promise((resolve) => {
          const id = ++patchId;
          patchWaiters.set(id, resolve);
          send({ type: 'patch', id, str: d.blueprint, k, storage, set });
        }),
    )
    .then((r) => {
      if (r.error) {
        setStatus(`改物流站设置没成功：${r.error}`, true);
        if (last === d && view.station === k) renderStation(); // 改回蓝图里的值
        return;
      }
      d.blueprint = r.blueprint;
      d.stationCfg = r.stationCfg;
      if (last !== d) return; // 又生成了一张，这张不显示了
      // 面板不重画（滑条、按钮已经是新值，重画会丢焦点），只换蓝图字符串和「接口」那栏
      $('bp').value = d.blueprint;
      $('bp-meta').textContent = `${d.blueprint.length.toLocaleString()} 字符`;
      fillPorts(d);
    });
}
/** 存储第 i 格改了：读这一行现在的值交给后台；翘曲器、增产剂那格记住 */
function storageChanged(row) {
  const k = view.station;
  const d = last;
  if (k == null || !d) return;
  const i = Number(row.dataset.i);
  const val = { localRole: Number(row.querySelector('[data-k="localRole"]').dataset.v), remoteRole: Number(row.querySelector('[data-k="remoteRole"]').dataset.v), max: Number(row.querySelector('[data-k="max"]').value) };
  const itemId = d.stationCfg[k].storage[i].itemId;
  const keep = itemId === 1210 ? 'warper' : SPRAY_IDS.includes(itemId) ? 'spray' : null;
  if (keep) {
    state.stationPrefs = { ...state.stationPrefs, [keep]: val };
    saveSettings();
  }
  patchStationOf(d, k, d.stationCfg[k].storage.map((_, j) => (j === i ? val : null)), null);
}
$('station-body').addEventListener('click', (e) => {
  const b = e.target.closest('.st-role');
  if (!b || b.disabled) return;
  const v = NEXT_ROLE[Number(b.dataset.v)];
  b.dataset.v = v;
  b.className = `st-role r${v}`;
  b.textContent = `${b.dataset.k === 'localRole' ? '本地' : '星际'}${ROLE_NAMES[v]}`;
  const row = b.closest('.st-row');
  if (b.dataset.k === 'remoteRole') row.className = `st-row r${v}`; // 左边色条跟着星际那头
  storageChanged(row);
});
// 拖滑条时数字跟着变，松手（change）才改蓝图
$('station-body').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.classList.contains('st-slider')) return;
  fillSlider(el);
  if (el.dataset.k === 'max') el.closest('.st-row').querySelector('.st-cap b').textContent = el.value;
  else {
    const d = STATION_SETS.find((x) => x.k === el.dataset.s);
    el.nextElementSibling.textContent = d.show(Number(el.value));
  }
});
$('station-body').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.k === 'max') return storageChanged(el.closest('.st-row'));
  const key = el.dataset.s;
  if (!key || !last || view.station == null) return;
  const d = STATION_SETS.find((x) => x.k === key);
  const v = el.type === 'checkbox' ? el.checked : d.get ? d.get(Number(el.value)) : Number(el.value);
  state.stationPrefs = { ...state.stationPrefs, station: { ...state.stationPrefs?.station, [key]: v } };
  saveSettings();
  patchStationOf(last, view.station, [], { [key]: v });
});

/** 简介框：选着线路写线路简介，选着工厂写工厂的介绍 */
function showRouteInfo() {
  const [z, index] = view.selected.split(':').map(Number);
  const run = view.selected && floorAt(z)?.runs[index];
  const info = $('route-info');
  info.hidden = !run && !view.factory;
  if (view.factory) {
    // 悬停提示按「 · 」分段：第一段（物品或建筑名）当标题，后面一段一行；色条用工厂轮廓的白线色
    const [name, ...rest] = view.factory.split(' · ');
    $('route-title').textContent = name;
    info.style.setProperty('--route-color', LINE);
    $('route-body').innerHTML = rest.map((s) => `<p>${esc(s)}</p>`).join('');
    return;
  }
  if (!run) return;
  const model = last.model;
  const item = model.items[run.itemId];
  const point = ([x, y]) => `(${x + (model.origin?.x ?? 0)}, ${y + (model.origin?.y ?? 0)})`;
  const sources = [...new Set(model.sorters.filter((s) => s.itemId === run.itemId && s.io === 'out').map((s) => s.factoryItem).filter(Boolean))];
  const consumers = [...new Set(model.sorters.filter((s) => s.itemId === run.itemId && s.io === 'in').map((s) => s.factoryItem).filter(Boolean))];
  const line = (label, value) => `<dt>${label}</dt><dd>${esc(value)}</dd>`;
  const vias = floorAt(z).vias.filter((v) => v.itemId === run.itemId && run.cells.some(([x, y]) => x === v.x && y === v.y));
  // 坡不记升降点（drawing.js 的 sliceRoutes）：前一段、后一段是坡接过来的也写上（往上走的段记 from，往下走的段记 to）
  const after = floors.flatMap((f) => f.runs).find((r) => r.prev === run);
  const slopes = [run.from || run.prev?.to ? run.prev : null, run.to || after?.from ? after : null].filter(Boolean).map((r) => r.z);
  const nextLevels = [...new Set([...vias.map((v) => v.to), ...slopes].map((l) => `L${l + 1}`))];
  $('route-title').textContent = item.name;
  info.style.setProperty('--route-color', routeColor(model, run.itemId));
  $('route-body').innerHTML = '<dl>' + line('当前线段', `L${z + 1} · ${run.cells.length} 格${nextLevels.length ? ` · 接 ${nextLevels.join('、')}` : ''}`)
    + line('输送方向', `${point(run.cells[0])} → ${point(run.cells.at(-1))}`)
    + line('产线总量', `${fmt(item.rate)}/分`)
    + line('物料来源', sources.length ? sources.map((name) => `${name}产线`).join('、') : model.stations.length ? '物流站输入' : '外部输入')
    + line('用于生产', consumers.length ? consumers.join('、') : '成品送出') + '</dl>';
}
$('close-route').addEventListener('click', clearRoute);
$('layer-controls').addEventListener('change', (e) => {
  if (!e.target.dataset.overlay || !last || busy) return;
  view[e.target.dataset.overlay] = e.target.checked;
  if (!view.buildings) view.factory = ''; // 建筑不画了，工厂的介绍也收起
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
      d.energy ? `<tr><th>用电</th><td class="wide" colspan="3">待机 ${esc(d.energy.idleText)} · 工作 ${esc(d.energy.workText)}${d.energy.sprayText ? ` · 喷涂另加 ${esc(d.energy.sprayText)}` : ''}</td></tr>` : ''
    }`;
}

function fillPorts(d) {
  if (d.stations?.length) {
    // 物流站居中：按站列出存储与站口
    const roleTxt = (r) => (r === 'supply' ? '供应' : r === 'warper' ? '星际需求' : '需求');
    // 蓝图里实际的设置（物流站简介里可能改过）：本地、星际一样就写一个，不一样分开写
    const cfgTxt = (x) => (x.localRole === x.remoteRole ? ROLE_NAMES[x.localRole] : `本地${ROLE_NAMES[x.localRole]}、星际${ROLE_NAMES[x.remoteRole]}`);
    $('ports').innerHTML = d.stations
      .map((st, k) => {
        const cfg = d.stationCfg?.[k]?.storage.filter((x) => x.itemId);
        const items = cfg?.length ? cfg.map((x) => `${esc(byId.get(x.itemId)?.name ?? x.itemId)}（${cfgTxt(x)}，上限 ${x.max}）`).join('、') : st.items.map((it) => `${esc(it.name)}（${roleTxt(it.role)}）`).join('、');
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
  // 箱子供货（plan/storage.js）：每组写在哪几行（排进行里的储物仓）或哪边哪一行（外面的储液罐）、几个仓、叠几层、装满够多少分钟；没接上的照旧按出入口写
  const stores = (d.stores || [])
    .slice()
    .sort((a, b) => (a.kind === b.kind ? b.y - a.y : a.kind === 'in' ? -1 : 1))
    .map((s) => `<li>${s.kind === 'in' ? '' : '成品 '}${esc(s.item)} <span class="num">${fmt(s.rate)}</span>/分：${s.rows ? `第 ${s.rows.map((y) => `<span class="num">${y}</span>`).join('、')} ${s.unit}` : `${s.side}边第 <span class="num">${s.y}</span> ${s.unit}`}的${s.what} <span class="num">${s.count}</span> 个${s.layers > 1 ? `，每个叠 <span class="num">${s.layers}</span> 层` : ''}${s.dist ? `，顶上放物流配送器（${s.kind === 'in' ? '向其他配送器需求' : '向其他配送器供应'}）` : ''}，装满够 <span class="num">${Math.floor(s.minutes)}</span> 分钟</li>`);
  const lines = d.ports
    .filter((p) => p.store == null)
    .sort((a, b) => (a.kind === b.kind ? b.y - a.y : a.kind === 'in' ? -1 : 1))
    .map((p) =>
      p.kind === 'in'
        ? `<li>${esc(p.item)} <span class="num">${fmt(p.rate)}</span>/分，从${p.side}边第 <span class="num">${p.y}</span> ${p.unit ?? '行'}送入</li>`
        : `<li>成品 ${esc(p.item)} <span class="num">${fmt(p.rate)}</span>/分，从${p.side}边第 <span class="num">${p.y}</span> ${p.unit ?? '行'}出来</li>`,
    );
  $('ports').innerHTML = [...stores, ...lines].join('') || '<li>没有外部接口。</li>';
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
  if (d.metrics.stationFallback) li.push('<li class="err">物流站没放进空地，改成了靠左侧站列。可以在「外部供应」里拆出一部分再试。</li>');
  if (d.metrics.coreSwitch) dev.push(`内核：排版内核搜了 ${d.metrics.coreSwitch.segments} 段还不可行，换主干内核从头排了一遍`);
  else if (d.metrics.core === 'typeset') dev.push('内核：排版内核');
  if (!d.feasible && d.metrics.factories > 120) li.push(`<li class="err">产线太大，排不下。可以在「外部供应」里把电路板、处理器这类中间产物设为外部供应，分开生成。</li>`);
  // 要超级磁场的：原地竖直升降（垂直传送带）、一格升一层的陡坡（worker.js 的 steep）
  const tech = [d.metrics.lifted && '直上直下的垂直传送带', d.metrics.steep && '一格升一层的陡坡'].filter(Boolean);
  if (tech.length && !d.metrics.noLift) li.push(`<li>用到${tech.join('和')}，前期没解锁「超级磁场发生器」时建不了。</li>`);
  if (d.metrics.noLift) dev.push('按没解锁「超级磁场发生器」出图（全部选了最低配置）：不用垂直传送带，高架升降走每格半层的坡；带上不放自动集装机');
  // 传送带重走（src/plan/reroute.js 的守门）：第几次换上，或者每次差在哪几项（why 每项一次尝试，键换成中文）
  const rr = d.metrics.reroute;
  if (rr?.tried) {
    const RR = { nodes: '带节', air: '离地', lifts: '原地升降', top: '最高层', stacked: '叠格', meet: '相遇', turns: '拐弯', area: '面积', finalCost: '最终代价' };
    const why = rr.why.map((w) => w.split('，').map((s) => s.replace(/^[a-zA-Z]+/, (k) => RR[k] ?? k)).join('，')).join('；');
    dev.push(rr.used ? `重走传送带：第 ${rr.used} 次换上（${rr.ms} 毫秒）` : `重走传送带：留了原图，${why}（${rr.ms} 毫秒）`);
  }
  if (d.metrics.orient) {
    const o = d.metrics.orient;
    if (o.used === 'v') li.push('<li>竖排：整张已经转好 90°，贴的时候不用再转。</li>');
    if (o.alt) dev.push(`另一个方向 ${o.alt.width}×${o.alt.height}、${o.alt.area} 格、传送带 ${o.alt.belts}${o.alt.feasible ? '' : '（不可行）'}`);
  }
  if (!d.metrics.power) li.push('<li>没放供电，贴好后自己补。</li>');
  if (d.latitude && !d.latitude.high) li.push(`<li>${esc(d.latitude.factory)}按赤道的紧凑间距排，只能贴在赤道附近。要贴到高纬度，打开「化工厂、精炼厂高纬度间距展开」。</li>`);
  const ad = d.addons;
  if (ad?.spray) {
    // 增产剂从哪进：只说哪几座物流站（站口编号进控制台），没有站时从边缘入口
    const st = [...new Set((ad.lines ?? []).map((x) => x.match(/^物流站 (\d+)/)?.[1]).filter(Boolean))];
    const boxed = (ad.lines ?? []).length && (ad.lines ?? []).every((x) => x.startsWith('储物仓')); // 箱子供货：增产剂带也从储物仓出（plan/storage.js）
    const where = st.length ? `物流站 ${st.join('、')} 里放增产剂` : boxed ? '增产剂放进储物仓' : '增产剂从边缘的入口送进来';
    li.push(`<li>${where}，约 ${fmt(ad.spray.rate)}/分。</li>`);
    dev.push(`增产剂带 ${ad.lines?.length ?? 0} 条：${(ad.lines ?? []).join('、')}；吃到增产的配方：${ad.spray.units.join('、')}`);
  }
  if (ad?.warper) li.push(`<li>空间翘曲器放进物流站 ${ad.warper.home}${ad.warper.to.length ? `，传送带会送到物流站 ${ad.warper.to.join('、')}` : ''}。</li>`);
  dev.push(...(ad?.notes ?? []));
  if (d.byproducts?.length)
    li.push(`<li>副产物 ${d.byproducts.map((b) => `${esc(b.name)} ${fmt(b.rate)}/分`).join('、')} 单独一条带送出${d.stations?.length ? '进物流站' : d.byproducts.every((b) => (d.stores ?? []).some((s) => s.kind === 'out' && s.item === b.name)) ? '进储物仓 / 储液罐，满了要取走' : '，要接走，不然会堵'}。</li>`);
  if (dev.length) console.info('[dsp-handcraft] 规划细节：\n' + dev.map((x) => `- ${x}`).join('\n'));
  $('notes').innerHTML = li.join('');
}
/**
 * 右侧栏「用电」一页（用户 2026/10/26：从「检查」挪过来）：待机、工作、喷涂另加、最大；最大用电按额定功率折成几台发电设施；有物流站时说一句充电另算。
 * e：结果的 energy（拼接成一张时是各块加起来的），没有就藏起这一页
 */
function fillPowerCard(e) {
  const box = $('power-pane');
  $('tab-power').hidden = !e;
  if (!e) {
    railTab(false);
    return (box.innerHTML = '');
  }
  const row = (k, v) => `<dt>${k}</dt><dd>${esc(v)}</dd>`;
  box.innerHTML =
    `<dl>${row('待机', e.idleText)}${row('工作', e.workText)}${e.sprayText ? row('喷涂另加', e.sprayText) : ''}${row('最大约', e.maxText)}</dl>` +
    `<table><caption>按额定功率要</caption>${e.gens.map((g) => `<tr><th>${esc(g.name)}</th><td>${g.n.toFixed(2)} ${esc(g.unit)}</td></tr>`).join('')}</table>` +
    (e.stations ? `<p>物流站充电另算（${e.stations} 座最多 ${esc(e.stationChargeText)}，电存满后就很少）</p>` : '');
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
  showLike();
  setTimeout(() => {
    for (const b of [$('copy'), $('copy-top')]) b.textContent = '复制蓝图';
  }, 2000);
});
$('copy-top').addEventListener('click', () => $('copy').click());

// ---------- 点赞（用户 2026/10/26）：括号里是全站的总数；一次生成点一次 ----------
// 点赞总数存在公共计数服务上（全站共享，不记人），换地方改这里
const LIKES = { base: 'https://abacus.jasoncameron.dev', ns: 'dsp-handcraft', key: 'likes' };
let likes = null; // 总数，没取到时为空
let likedThis = false; // 这一次生成的结果点过了
function renderLike() {
  $('like-count').textContent = `${likedThis ? '已赞' : '点赞'}${likes == null ? '' : ` (${likes})`}`;
}
/** 问计数服务：get 只读总数（还没人点过时是 404，算 0），hit 加一再回总数；连不上就算了，不报错 */
function askLikes(op) {
  try {
    fetch(`${LIKES.base}/${op}/${LIKES.ns}/${LIKES.key}`, { cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then((r) => (op === 'get' && r.status === 404 ? { value: 0 } : r.json()))
      .then((j) => {
        if (!Number.isFinite(j?.value) || (op === 'get' && likes != null)) return; // 点过以后才回来的 get 不认
        likes = j.value;
        renderLike();
      })
      .catch(() => {});
  } catch {
    /* 没有 fetch 的老浏览器 */
  }
}
/** 出了新的一张：重新可点，但先藏着，复制了蓝图才露出来（用户 2026/10/26：点赞放在复制之后） */
function resetLike() {
  likedThis = false;
  $('like').hidden = true;
  $('like').disabled = false;
  renderLike();
}
/** 复制了蓝图：点赞按钮露出来（这一张还没点过才能点） */
function showLike() {
  if ($('bp').value) $('like').hidden = false;
  $('like').disabled = likedThis;
  renderLike();
}
$('like').addEventListener('click', () => {
  if (likedThis) return;
  likedThis = true;
  $('like').disabled = true;
  if (likes != null) likes++; // 先当点上了（连不上也一样），服务回了总数再换成它的
  renderLike();
  askLikes('hit');
});
askLikes('get');

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

/** 页面初始状态：图纸参数与物品表在画布下方；集装收起（摘要一行） */
function initView() {
  $('result-body').append($('sheet-foot'));
  syncLogistics();
  togglePile();
  renderMore();
}
// ---------- 从别的网页带过来的方案（地址里的 #plan=，见 handoff.js） ----------
// 目标、配方、设备先填好；外部供应是物品 ID，等物品列表到了换成名字，再按建议补齐（需要原油精炼厂等的中间产物），然后自动排一次
let handoff = readHandoff(location.hash);
function applyHandoff() {
  state.targets = handoff.targets.map((t) => ({ ...t }));
  state.recipes = { ...handoff.recipes };
  state.defs = handoff.defs;
  state.ext = new Set();
  for (const [k, v] of Object.entries(handoff.options)) if (document.querySelector(`input[name="${k}"][value="${v}"]`)) state[k] = v;
  if (handoff.labstack) state.labstack = labStackOf(handoff.labstack);
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
initPills();
loadSettings();
if (handoff) applyHandoff();
initView();
syncOptionSelects(); // 单选按读到的设置勾好了，图纸上方那排按钮跟着写
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
if (state.defs) send({ type: 'defs', defs: state.defs });
send({ type: 'catalog', id: ++catId, raw: [] });
