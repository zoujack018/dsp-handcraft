// 网页后台线程：计算 → 规划 → 出蓝图 → 独立检查。和命令行用的是同一套代码。
import { blueprintText, blueprintSize, spaceStats } from '../../src/metrics/space.js';
import { calculate } from '../../src/calc/calculator.js';
import { planLine, planLineAsync, finishOne, finishContext } from '../../src/plan/index.js';
import { buildGraph } from '../../src/plan/graph.js';
import { splitLine, planModule } from '../../src/plan/modules.js';
import { stitchBlueprints } from '../../src/emit/stitch.js';
import { powerDemand, powerText, sumPower, fmtWatts } from '../../src/metrics/energy.js';
import { runTask } from '../../src/plan/tasks.js';
import { validate } from '../../src/plan/validate.js';
import { emitBlueprint } from '../../src/emit/blueprint.js';
import { checkBlueprint } from '../../src/emit/check.js';
import { ITEMS, RAW_ITEM_IDS, factory, hasHighLatitude, recipeChoices, defaultRecipe, burnPerMinute } from '../../src/gamedata.js';
import { renderModel } from './model.js';
import { autoWatcher, previewShapeOk } from './autowatch.js';
import vanilla from '../../data/Vanilla.json' with { type: 'json' };
import { fractionatorArray, checkArray, arrayModel, arrayPlan } from '../../src/fractionate/array.js';

// 重氢的「分馏塔阵列」：不是普通配方（分馏塔不接分拣器、带子从塔里穿过），选了它就单独生成一张分馏阵列蓝图
const DEUTERIUM = 1121;
const FRAC_RECIPE = 115;
const FRAC_CHOICE = { id: FRAC_RECIPE, name: '重氢分馏（分馏塔阵列）', line: '氢 → 重氢，分馏塔阵列：照你给的 60 塔图裁剪，单独一张蓝图' };
/** 选了分馏：从配方里拿掉（计算器不认分馏塔），重氢不是目标时当外部供应 */
function splitFraction(targets, raw, recipes) {
  const on = Number(recipes?.[DEUTERIUM]) === FRAC_RECIPE;
  if (!on) return { on, raw, recipes: recipes || {} };
  const rest = { ...recipes };
  delete rest[DEUTERIUM];
  const isGoal = targets.some((t) => Number(t.target) === DEUTERIUM);
  return { on, raw: isGoal || raw.includes('重氢') ? raw : [...raw, '重氢'], recipes: rest, isGoal };
}

// 搜索力度按空间利用率的目标分档：达到目标就停，没达到就把面积的权重加倍再搜，最多 retries 轮
// （用户 2026-10-04：快 >50%、中 >70%、细 >85%；2026/10/07 改成 50 / 66 / 80，85 太高了）。细档不设时间上限，一百多台工厂的产线要几分钟。
// 没达标（不可行或利用率不到这一档）就换种子接着搜，直到达标或到 untilTarget.maxMs（快 15 分钟、标准 60 分钟、细 200 分钟）。
// 上限只防极端的长尾，按大约 95% 的人碰不到来定（用户 2026/10/07）；到点还没达标就交出搜到的最好那张，页面照常显示，状态栏说明没到这一档
// 快档每轮 3000 步（2026/10/08，用户定）：云上和考卷都量过每轮步数是最管用的旋钮，1500 → 3000 不喷的 36 格面积少 4%~5%、利用率 +2 个百分点、
// 放大 3 倍那套全部可行，线程时间 1.4~1.6 倍；每轮上限跟着 10 → 20 秒，不然 Mac 上引力矩阵 30 一轮（约 12 秒）会被截掉
const EFFORT = {
  quick: { iterations: 3000, restarts: 2, timeLimit: 20000, targetSpace: 0.5, retries: 1, untilTarget: { maxMs: 15 * 60000 } },
  normal: { iterations: 3000, restarts: 4, timeLimit: 30000, targetSpace: 0.66, retries: 2, untilTarget: { maxMs: 60 * 60000 }, powerHoles: true },
  fine: { iterations: 8000, restarts: 6, timeLimit: null, targetSpace: 0.8, retries: 4, untilTarget: { maxMs: 200 * 60000 }, powerHoles: true },
};

/**
 * 物品陈列：按游戏里的格位（GridIndex = 页×1000 + 行×100 + 列）列出全部物品，并标出状态：
 *   raw        原矿，始终从边缘供应
 *   ok         只用熔炉/制造台就能做（考虑已选的外部供应）
 *   partial    产线里有原油精炼厂等暂不支持的工厂，选中后会建议把它们设为外部供应
 *   self       它本身就要用原油精炼厂等暂不支持的工厂，不能作为目标
 *   none       没有单产物的常规配方（比如只能由精炼副产得到），只能当外部供应
 */
function catalog(raw = []) {
  const out = [];
  for (const it of ITEMS.values()) {
    const gi = vanilla.items.find((x) => x.ID === it.id)?.GridIndex ?? -1;
    if (gi < 1000) continue;
    let status;
    if (RAW_ITEM_IDS.has(it.id)) status = 'raw';
    else {
      if (!defaultRecipe(it.id)) status = 'none';
      else {
        try {
          const calc = calculate({ target: it.id, rate: 60, raw: raw.filter((n) => n !== it.name) });
          const self = calc.units.find((u) => u.itemId === it.id);
          status = self && !factory(self.factoryId).supported ? 'self' : calc.units.every((u) => factory(u.factoryId).supported) ? 'ok' : 'partial';
        } catch {
          status = 'partial';
        }
      }
    }
    out.push({
      id: it.id,
      name: it.name,
      page: Math.floor(gi / 1000),
      row: Math.floor((gi % 1000) / 100),
      col: gi % 100,
      type: it.type,
      icon: vanilla.items.find((x) => x.ID === it.id)?.IconName ?? '',
      status,
    });
  }
  return out;
}

/** 依次把最靠近目标的「不支持的工厂」所产物品设为外部供应，直到整条线都能排；返回需要的外部供应列表 */
function minimalExternal(targets, base, recipes = {}) {
  const ext = [...base];
  const goalIds = new Set();
  for (let i = 0; i < 60; i++) {
    const c = calculate({ targets, raw: ext, recipes });
    c.targets.forEach((t) => goalIds.add(t.itemId));
    const bad = c.units.find((u) => !goalIds.has(u.itemId) && !factory(u.factoryId).supported);
    if (!bad) return ext;
    ext.push(bad.item);
  }
  return ext;
}

/**
 * 目标产物的中间产物清单与依赖关系，供「外部供应」弹窗使用。
 *   goals：最终目标（第 0 层）。
 *   units：完整产线（不设外部供应）里除目标外的每种中间产物，带层级（离最近的目标最远几步）、所需工厂、
 *          当前是否仍在产线里（上游被设为外部供应后，它可能已经不需要了）、是否被设为外部供应。
 *   edges：谁被谁消耗：from 物品 → to 物品（消费者），rate 为当前流量（不在产线里时为完整产线的流量），
 *          state = line（还在产线里）/ external（来源改为外部供应）/ dropped（消费者已不需要）。
 *   suggested：让整条线可排的最少外部供应（基于当前选择补齐）。
 */
/** 配方写成一行：可燃冰×2 → 石墨烯×2 + 氢×1 */
const recipeLine = (r) => `${r.inputs.map((x) => `${ITEMS.get(x.id).name}×${x.count}`).join(' + ')} → ${r.outputs.map((x) => `${ITEMS.get(x.id).name}×${x.count}`).join(' + ')}`;

function chain({ targets, raw: raw0 = [], recipes: recipes0 = {}, lab = 2901, labStack = 15 }) {
  const frac = splitFraction(targets, raw0, recipes0);
  const raw = frac.raw;
  const recipes = frac.recipes;
  const full = calculate({ targets, raw: [], recipes, lab: Number(lab), labStack: Number(labStack) });
  const cur = calculate({ targets, raw, recipes, lab: Number(lab), labStack: Number(labStack) });
  const goalIds = new Set(full.targets.map((t) => t.itemId));
  const curUnits = new Map(cur.units.map((u) => [u.itemId, u]));
  const curRaw = new Map(cur.raw.map((r) => [r.itemId, r.rate]));
  const unitByItem = new Map(full.units.map((u) => [u.itemId, u]));
  const itemOfUnit = (calc) => new Map(calc.units.map((u) => [u.id, u.itemId]));
  const fullOwner = itemOfUnit(full);
  const curOwner = itemOfUnit(cur);
  // 层级：目标为 0，它的输入为 1，以此类推，取最深（同一物品被不同层消耗时放在最下面那层）
  // 多个目标时单遍扫描不一定按拓扑序，反复松弛到不再变化（生产图无环，最多 units 轮）
  const depth = new Map([...goalIds].map((id) => [id, 0]));
  for (let round = 0, changed = true; changed && round <= full.units.length; round++) {
    changed = false;
    for (const fl of full.flows) {
      if (fl.to === 'OUT' || !unitByItem.has(fl.itemId) || goalIds.has(fl.itemId)) continue;
      const owner = fullOwner.get(fl.to);
      if (owner === fl.itemId) continue; // 自环：比如重整精炼用精炼油做精炼油
      const d = depth.get(owner);
      if (d == null) continue;
      if ((depth.get(fl.itemId) ?? -1) < d + 1) {
        depth.set(fl.itemId, d + 1);
        changed = true;
      }
    }
  }
  const describe = (u) => {
    const f = factory(u.factoryId);
    const now = curUnits.get(u.itemId);
    const external = raw.includes(u.item);
    return {
      id: u.itemId,
      name: u.item,
      type: ITEMS.get(u.itemId).type,
      depth: goalIds.has(u.itemId) ? 0 : depth.get(u.itemId) ?? 1,
      factory: f.name,
      supported: f.supported,
      count: now ? now.count : u.count,
      levels: (now ?? u).levels ?? null, // 研究站：count 是叠数，每叠几层
      rate: now ? now.outputRate : curRaw.get(u.itemId) ?? u.outputRate,
      state: external ? 'external' : now ? 'line' : 'dropped',
    };
  };
  const goals = full.targets.map((t) => ({ ...describe(unitByItem.get(t.itemId)), out: t.rate }));
  // 目标重氢选了分馏阵列：塔数、耗氢按分馏算（1 个氢分出 1 个重氢）
  if (frac.on && frac.isGoal) for (const g of goals) if (g.id === DEUTERIUM) Object.assign(g, { factory: '分馏塔', count: arrayPlan(g.out).towers });
  const units = full.units.filter((u) => !goalIds.has(u.itemId)).map(describe);
  // 依赖边：只连中间产物和目标之间（原矿不在弹窗里）
  const curRate = new Map();
  for (const fl of cur.flows) if (fl.to !== 'OUT') curRate.set(`${fl.itemId}>${curOwner.get(fl.to)}`, fl.rate);
  const edges = [];
  for (const fl of full.flows) {
    if (fl.to === 'OUT' || !unitByItem.has(fl.itemId)) continue;
    const to = fullOwner.get(fl.to);
    if (to === fl.itemId) continue;
    const key = `${fl.itemId}>${to}`;
    const live = curRate.get(key);
    const state = live != null ? (raw.includes(unitByItem.get(fl.itemId).item) ? 'external' : 'line') : 'dropped';
    edges.push({ from: fl.itemId, to, rate: live ?? fl.rate, state });
  }
  return {
    title: full.targets.map((t) => `${t.name} ${t.rate}/分`).join(' + '),
    goals,
    units,
    edges,
    raws: frac.on && frac.isGoal && targets.length === 1 ? [{ name: '氢', rate: Number(targets[0].rate) }] : cur.raw.filter((r) => !raw.includes(r.item)).map((r) => ({ name: r.item, rate: r.rate })),
    blocking: cur.units.filter((u) => !goalIds.has(u.itemId) && !factory(u.factoryId).supported).map((u) => u.item),
    suggested: minimalExternal(targets, raw, recipes),
    // 有新配方的物品（目标和还在产线里的中间产物）：弹窗底部逐个开关
    recipes: [...full.targets.map((t) => t.itemId), ...full.units.map((u) => u.itemId)]
      .filter((id, i, a) => a.indexOf(id) === i && ((id === DEUTERIUM && frac.on) || (!raw.includes(ITEMS.get(id).name) && (cur.units.some((u) => u.itemId === id) || full.targets.some((t) => t.itemId === id)))))
      .map((id) => ({ id, name: ITEMS.get(id).name, choices: id === DEUTERIUM ? [...recipeChoices(id), FRAC_CHOICE] : recipeChoices(id) }))
      .filter((x) => x.choices.length > 1)
      .map((x) => ({
        id: x.id,
        name: x.name,
        def: { id: x.choices[0].id, name: x.choices[0].name, line: recipeLine(x.choices[0]) },
        alts: x.choices.slice(1).map((r) => ({ id: r.id, name: r.name, line: r.line ?? recipeLine(r) })),
        chosen: x.id === DEUTERIUM && frac.on ? FRAC_RECIPE : Number(recipes[x.id]) || null,
      })),
    // 副产物：能不能在火力发电厂烧、满负荷要几台（弹窗里「就地烧掉」的开关用）
    byproducts: cur.byproducts.map((b) => ({ id: b.itemId, name: b.item, rate: b.rate, of: ITEMS.get(b.of).name, burnable: burnPerMinute(b.itemId) > 0, plants: burnPerMinute(b.itemId) > 0 ? Math.ceil(b.rate / burnPerMinute(b.itemId) - 1e-9) : 0 })),
  };
}

/** 原料入口与成品出口，告诉玩家从哪接 */
function ports(graph, L) {
  return L.ports.map((p) => {
    const left = p.x < L.width / 2;
    const at = p.y + (L.origin?.y ?? 0); // 「第几行」按蓝图里的坐标说，外沿加地后要平移
    return {
      kind: p.kind,
      item: graph.items.get(p.itemId)?.name ?? ITEMS.get(p.itemId)?.name ?? String(p.itemId),
      rate: p.rate,
      // 竖排的蓝图整张顺时针转了 90°：原来的左边成了上边、右边成了下边，第几行成了第几列
      side: L.rotated ? (left ? '上' : '下') : left ? '左' : '右',
      unit: L.rotated ? '列' : '行',
      x: p.x,
      y: at,
    };
  });
}
/** 布局坐标（含外沿平移）→ 蓝图坐标：竖排时整张顺时针转了 90° */
const toBlueprint = (L, x, y) => (L.rotated ? { x: y, y: L.width - 1 - x } : { x, y });

// ---------- 多线程 ----------
// 这个线程是总调度；页面把打包好的脚本源码发过来（init），这里再开 threads 个帮手线程（同一份脚本），
// 搜索的各轮退火、各个候选的后处理分给它们并行。浏览器不让后台线程再开线程时，退回单线程。
let helperUrl = null;
let threads = 1;
let pool = null; // null 未建，false 不可用
function makePool() {
  if (pool !== null) return pool;
  pool = false;
  if (!helperUrl || threads < 2 || typeof Worker === 'undefined') return pool;
  try {
    const idle = [];
    const queue = [];
    const waiting = new Map();
    let seq = 0;
    const pump = () => {
      while (idle.length && queue.length) {
        const w = idle.pop();
        const job = queue.shift();
        waiting.set(job.id, job);
        w.postMessage({ type: 'task', id: job.id, task: job.task });
      }
    };
    const workers = Array.from({ length: threads }, () => {
      const w = new Worker(helperUrl);
      w.onmessage = (ev) => {
        const { id, result, error, progress } = ev.data;
        const job = waiting.get(id);
        if (!job) return;
        if (progress) {
          // 搜索中途的快照（实时预览），不是任务完成：交给上层转发，活接着等
          pool.onProgress?.(job.task, progress);
          return;
        }
        waiting.delete(id);
        idle.push(w);
        pump();
        if (error) job.reject(new Error(error));
        else job.resolve(result);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        for (const job of waiting.values()) job.reject(new Error(e.message || '帮手线程出错'));
        waiting.clear();
      };
      idle.push(w);
      return w;
    });
    pool = {
      size: workers.length,
      run: (task) => new Promise((resolve, reject) => {
        queue.push({ id: ++seq, task, resolve, reject });
        pump();
      }),
      // 「就这个蓝图了」：停掉所有帮手线程（正在跑的退火没法中途叫停，只能整个关掉），没做完的活都按出错退回；下次生成再新开
      stop: () => {
        for (const w of workers) w.terminate();
        for (const job of [...waiting.values(), ...queue.splice(0)]) job.reject(new Error('已停止'));
        waiting.clear();
        pool = null;
      },
    };
  } catch {
    pool = false;
  }
  return pool;
}
/** 帮手线程能不能用：发一个空活，3 秒内没回音就当不能用 */
async function poolReady() {
  const p = makePool();
  if (!p) return null;
  if (p.checked) return p.ok ? p : null;
  p.checked = true;
  p.ok = await Promise.race([p.run({ kind: 'ping' }).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]);
  return p.ok ? p : null;
}

/**
 * 开搜前的预计用时（秒），给进度条：每段（一遍搜索 + 后处理）按实测拟合的乘幂模型
 *   log 秒数 = 常数 + b·log 台数 + c·log 配方组数 + 物流站的偏移（放进空地 / 左侧站列）+ 供电的偏移（塔 / 配电站），
 * 搜索和后处理各一套系数。数据：2026/10/07 在 Apple M4 Pro 上 12 线程按「快」档实跑 47 条线（5~576 台、2~36 组）× 6 种初始条件
 * （tools/time-measure.js），拟合和统计图见 tools/time-fit.js、docs/timing/。2026/10/07 夜 v2.0 提速后重量重拟：整条线留出的留一法验证
 * 每段总时间误差中位数 18%、80% 分位 37%（Windows 15%、28%）；只看台数是 36%、71%（台数多组数少的线会估高，组数多的估低），
 * 用户 2026/10/07 猜「和有多少群有关」是对的。
 * 拟合按每个线程一轮 1500 步量（2026/10/07 的快档）；各档按步数 ÷ 1500、每线程轮数等比放大，有时间上限的档到点封顶（快档现在 3000 步、20 秒）。
 * 跑约一秒后页面改用实测速度（previewer 的 liveEst），这里只管开头和别的机器上的初值（Windows i9-14900HX 16 线程的系数也在 docs/timing/fits.json）。
 */
// [常数, log 台数, log 组数, 放进空地, 左侧站列, 电力感应塔, 卫星配电站]
const TIME_FIT = {
  search: [-3.9901, 0.3211, 0.9172, 0.1342, 0.7914, -0.1539, -0.1512],
  finish: [-10.5757, 0.9436, 0.9816, 1.5398, 0.4525, 0.9804, 0.7883],
};
function estimateSeconds(calc, effort, p, threads, restarts) {
  const machines = calc.units.reduce((n, u) => n + u.count, 0);
  const st = p.station === 'ils-side' ? 'side' : p.station ? 'edge' : 'none';
  const x = [1, Math.log(machines), Math.log(calc.units.length), st === 'edge' ? 1 : 0, st === 'side' ? 1 : 0, p.power === 'tesla' ? 1 : 0, p.power === 'substation' ? 1 : 0];
  const ev = (w) => Math.exp(w.reduce((a, wi, i) => a + wi * x[i], 0));
  let search = ev(TIME_FIT.search) * (effort.iterations / 1500) * Math.ceil(restarts / Math.max(1, threads));
  if (effort.timeLimit) search = Math.min(search, effort.timeLimit / 1000);
  return { search, finish: ev(TIME_FIT.finish) };
}
/**
 * 给帮手线程池包一层，数搜索的轮数和后处理的候选数，报给页面（type: 'progress'）。
 * 利用率不到目标、加重面积再搜时搜索的总轮数会变多，估算跟着加一段
 */
function tracked(helpers, id, est, restarts, preview = null) {
  const n = { search: [0, 0], finish: [0, 0] };
  const post = () => {
    const phases = Math.max(1, Math.ceil(n.search[1] / Math.max(1, restarts)));
    // 实测估时（previewer 跑约一秒后算出）比开搜前按配方组数估的公式准，有就用它
    const live = preview?.liveEst;
    self.postMessage({ type: 'progress', id, est: live ?? est.search * phases + est.finish * phases, live: live != null, maxMs: preview?.maxMs ?? null, search: n.search, finish: n.finish });
  };
  post();
  if (!helpers) return null;
  return {
    size: helpers.size,
    run: (task) => {
      const k = n[task.kind];
      if (!k) return helpers.run(task);
      k[1]++;
      // 给搜索任务标上第几段（没达标接着搜时一段一段来），快照带着它回来，预览好不认上一段的旧账
      if (task.kind === 'search') task.gen = Math.max(1, Math.ceil(k[1] / Math.max(1, restarts)));
      post();
      return helpers.run(task).then((r) => {
        k[0]++;
        post();
        return r;
      });
    },
  };
}

/**
 * 实时预览（观摩退火）+ 实测估时，同一条快照通道两用。
 * 帮手线程每半秒把「这一轮搜到第几步」连同温度、代价报上来（见 onmessage 的 task 分支），这里：
 *   1）数字全转发给页面（type 'preview'）；绘图模型只转发页面正在看的那一轮——自动模式看利用率最高的那一轮，
 *      但不频繁切换（autowatch.js：别的轮连续领先够久才切，两次切换有间隔下限）；页面发 { type: 'watch', round } 指定看第几轮（'auto' 传 null）；
 *   2）跑满约一秒后用实测速度估剩余时间（剩余步数 ÷ 速度，几轮并行取最慢的那轮），自动适应不同 CPU、
 *      线程数和浏览器；第一秒之前页面沿用 estimateSeconds 的公式。
 * 没达标接着搜（untilTarget）时每段搜索是新一段（gen），上一段的快照不再理会。
 */
function previewer(id, est, restarts, threads, maxMs) {
  const t0 = Date.now();
  const rounds = new Map(); // 这一段里每轮的进度：{ first, i0, t, i, iterations, best, space, timeLimit }
  let gen = 1;
  const ctl = { id, watch: 'auto', liveEst: null, maxMs, lastSent: 0, forceNext: false };
  const autoPick = autoWatcher();
  const estimate = (now) => {
    let slowest = 0;
    let n = 0;
    let avg = 0;
    for (const r of rounds.values()) {
      if (now - r.t > 2500) continue; // 已经搜完的轮不算
      if (r.t - r.first < 900 || r.i <= r.i0) continue; // 跑满约一秒才有实测速度
      const v = ((r.i - r.i0) * 1000) / (r.t - r.first); // 步/秒
      let left = (r.iterations - r.i) / v;
      if (r.timeLimit) left = Math.min(left, Math.max(0, r.timeLimit - (now - r.first)) / 1000); // 有时间上限的轮到点收手
      slowest = Math.max(slowest, left);
      n++;
      avg += r.iterations / v;
    }
    if (!n) return;
    // 轮数多于线程时还有没开跑的轮，按实测的平均每轮时长补上
    const waves = Math.ceil(Math.max(0, restarts - rounds.size) / Math.max(1, threads));
    ctl.liveEst = (now - t0) / 1000 + slowest + waves * (avg / n) + est.finish;
    self.postMessage({ type: 'progress', id, est: ctl.liveEst, live: true, maxMs });
  };
  /** 收一份快照。task 是线程池里那份活（带 gen、options）；单线程回退时传 { gen: 1, options } */
  ctl.take = (task, p) => {
    if (task.kind && task.kind !== 'search') return;
    const g = task.gen ?? 1;
    const now0 = Date.now();
    if (g > gen) {
      gen = g;
      rounds.clear();
      autoPick.newSegment(now0);
      ctl.liveEst = null;
    } else if (g < gen) return;
    const now = Date.now();
    let r = rounds.get(p.s);
    if (!r) rounds.set(p.s, (r = { first: now, i0: p.i, timeLimit: task.options?.timeLimit ?? null }));
    Object.assign(r, { t: now, i: p.i, iterations: p.iterations, best: p.best, space: p.space });
    // 自动模式每份快照都过一遍（挑战者连续领先多久要按时间记），不只在带图的那份
    const auto = autoPick(rounds, now);
    let model = p.model;
    if (model) {
      const sel = ctl.watch === 'auto' ? auto : ctl.watch;
      // 页面只画正在看的那一轮，其余轮只发数字；图每 PREVIEW_EVERY 才换一张（用户 2026/10/07：别频繁更新），
      // 页面上点了别的轮马上给一张；长宽比离谱、超出宽长上限的排法不给（autowatch.js 的 previewShapeOk）
      if (sel !== p.s || (!ctl.forceNext && now - ctl.lastSent < PREVIEW_EVERY) || !previewShapeOk(model, task.options?.routeOptions)) model = null;
      else {
        ctl.lastSent = now;
        ctl.forceNext = false;
        ctl.shown = { layout: p.layout, options: task.options, round: p.s }; // 页面正在画的就是这一张（「就这个蓝图了」收尾用）
      }
    }
    self.postMessage({ type: 'preview', id, gen: g, round: p.s, i: p.i, iterations: p.iterations, T: p.T, cost: p.cost, best: p.best, feasible: p.feasible, model });
    estimate(now);
  };
  return ctl;
}
let curPreview = null; // 正在跑的那份规划的实时预览（页面的 watch 消息找它）
let curRun = null; // 正在跑的那份规划：{ id, calc, p, effort, t0, threads }（「就这个蓝图了」收尾用）
let activeId = 0;
const taken = new Set(); // 已经按「就这个蓝图了」交了结果的请求：搜索那边后来再出结果就不发了

/**
 * 就这个蓝图了（用户 2026/10/07：搜索过程中直接把实时渲染的那一张交出来，结束任务）：
 * 拿页面正在画的那一轮当前排法（previewer 记下的 ctl.shown），按那份搜索任务的设置走一遍后处理（接物流站、落地、增产剂、供电、烧副产物），
 * 出蓝图、独立检查，当作这次生成的结果发给页面；再停掉帮手线程。收尾失败（比如这张接不上物流站）就告诉页面，搜索照常继续。
 */
function takeShown(id) {
  const ctl = curPreview;
  const run = curRun;
  if (!ctl || ctl.id !== id || !ctl.shown || !run || run.id !== id) {
    self.postMessage({ type: 'take-failed', id, reason: '还没有能交的图，等图纸区出现排法再点。' });
    return;
  }
  let fin = null;
  try {
    fin = finishOne({ layout: ctl.shown.layout }, finishContext(run.calc, ctl.shown.options));
  } catch (e) {
    self.postMessage({ type: 'take-failed', id, reason: `这一张收尾出错：${e.message}` });
    return;
  }
  if (!fin) {
    self.postMessage({ type: 'take-failed', id, reason: '这一张接不上物流站，等下一张图再试（搜索照常继续）。' });
    return;
  }
  taken.add(id);
  pool?.stop?.();
  curPreview = null;
  const plan = { graph: buildGraph(run.calc), layout: fin.layout, ms: Date.now() - run.t0, searchRounds: 1, targetMet: false, stalled: false, picked: { round: ctl.shown.round + 1 } };
  const data = describePlan(plan, run.calc, run.p, run.effort, run.threads);
  self.postMessage({ type: 'result', id, data });
}
const PREVIEW_EVERY = 25000; // 预览的图多久换一张

/** 页面参数 → calculate() 的参数。chemtight：左栏「化工厂赤道间距压缩」，开了化工厂、量子化工厂才按赤道压缩的间距排，默认加宽（任何纬度都能放） */
function lineInput(p, targets, frac) {
  return { targets, assembler: Number(p.assembler), smelter: Number(p.smelter), chemical: Number(p.chemical || 2309), lab: Number(p.lab || 2901), labStack: Number(p.labstack || 15), raw: frac.raw, recipes: frac.recipes, spray: Number(p.spray || 0), latitude: p.chemtight === '1' ? 'equator' : 'high' };
}

async function run(p, id = 0) {
  const targets = (p.targets || [{ target: p.target, rate: p.rate }]).map((t) => ({ target: Number(t.target), rate: Number(t.rate) }));
  const frac = splitFraction(targets, (p.raw || []).filter(Boolean), p.recipes || {});
  if (frac.on && frac.isGoal) {
    if (targets.length > 1) return { error: '重氢选了分馏塔阵列时，目标只能是重氢一种（分馏阵列单独一张蓝图）。可以把别的目标另外生成，重氢设为外部供应。' };
    return fractionRun(targets[0].rate, Number(p.spray || 0));
  }
  const input = lineInput(p, targets, frac);
  const pool = await poolReady();
  const effort = EFFORT[p.effort || 'normal'];
  // 各轮退火分给各线程：轮数补成线程数的整数倍，墙上时间不变，搜得更广（4 线程时细档 6 轮补成 8 轮）
  const restarts = pool ? Math.ceil(effort.restarts / pool.size) * pool.size : effort.restarts;
  // 开了「自动切分」时：物品种类太多、一块排不下的产线切成几块（src/plan/modules.js），每块单独排，一起交给线程池
  const mods = p.split === '1' ? splitLine(input) : null;
  const est = estimateSeconds(calculate(input), effort, p, pool ? pool.size : 1, restarts);
  activeId = id;
  curRun = mods ? null : { id, calc: calculate(input), p, effort, t0: Date.now(), threads: pool ? pool.size : 1 };
  // 实时预览 + 实测估时：切块时几块同时搜，轮号对不上块，先不开（估时也照旧用公式）
  const preview = mods ? null : previewer(id, est, restarts, pool ? pool.size : 1, effort.untilTarget?.maxMs ?? null);
  curPreview = preview;
  if (pool && preview) pool.onProgress = (task, snap) => preview.take(task, snap);
  // 进度：切了块时几块一起排，按整条线估一段搜索的时间，一段 = 各块的轮数加起来
  const helpers = tracked(pool, id, est, mods ? effort.restarts * mods.length : restarts, preview);
  // 每搜完一轮（含没达标接着搜的）报一次：第几轮、目前最好的利用率、可不可行
  const onRound = (r) => self.postMessage({ type: 'progress', id, round: r.round, best: r.space, feasible: r.feasible, target: r.target });
  if (mods) {
    const t0 = performance.now();
    const results = await Promise.all(mods.map((m) => planOne(calculate(m.input), p, helpers, effort, effort.restarts, true)));
    const bad = results.find((r) => r.error);
    if (bad) return bad; // 比如某块里有还不支持的工厂：照旧提示改成外部供应
    const whole = calculate(input);
    const title = whole.targets.map((t) => `${t.name} ${t.rate}/分`).join(' + ');
    // 拼接成一张：按物流站间距、供电设施间距等规则摆开（src/emit/stitch.js）
    const stitched = p.stitch === '1'
      ? (() => {
          const r = stitchBlueprints(results.map((x) => ({ str: x.blueprint })), {
            maxWidth: p.maxwidth ? Number(p.maxwidth) : null,
            title: `${whole.targets.map((t) => t.name).join('+')}（${mods.length} 块拼接）`,
            desc: `dsp-handcraft：${title}，切成 ${mods.length} 块拼成一张：${mods.map((m, k) => `${k + 1}. ${m.name}`).join('；')}`,
          });
          return { blueprint: r.str, width: r.width, height: r.height, offsets: r.offsets, gap: r.gap, check: { ok: r.check.ok, errors: r.check.errors.slice(0, 12), warnings: r.check.warnings }, stations: r.check.stats.stations, power: r.check.stats.power, energyText: powerText(sumPower(results.map((x) => x.energy))) };
        })()
      : null;
    return {
      // 切了块：每块都达标才算达标（利用率取最低的那块）
      goal: { met: results.every((r) => r.goal?.met), space: Math.min(...results.map((r) => r.goal?.space ?? 1)), target: effort.targetSpace, feasible: results.every((r) => r.goal?.feasible), rounds: Math.max(...results.map((r) => r.goal?.rounds ?? 1)), stalled: results.some((r) => r.goal?.stalled) },
      stitched,
      modules: results.map((r, k) => ({ ...r, module: { k, name: mods[k].name, smelt: mods[k].smelt, machines: mods[k].machines, items: mods[k].items, makes: mods[k].targets.map((t) => ({ name: ITEMS.get(t.itemId).name, rate: t.rate })), needs: mods[k].inputs.map((id) => ITEMS.get(id).name) } })),
      split: { items: new Set(whole.flows.map((f) => f.itemId)).size, machines: whole.units.reduce((n, u) => n + u.count, 0) },
      title,
      ms: performance.now() - t0,
      threads: helpers ? helpers.size : 1,
    };
  }
  return planOne(calculate(input), p, helpers, effort, restarts, false, onRound, preview);
}

/** 排一块：搜索、出蓝图、检查，整理成页面要的结果。module：切出来的一块（物流站退回站列时换种子再排） */
async function planOne(calc, p, helpers, effort, restarts, module = false, onRound = null, preview = null) {
  let plan;
  let options;
  let once;
  try {
    options = {
      ...effort,
      restarts,
      routeOptions: {
        belt: Number(p.belt),
        sorter: Number(p.sorter),
        maxAspect: p.aspect ? Number(p.aspect) : null,
        maxWidth: p.maxwidth ? Number(p.maxwidth) : null,
        maxHeight: p.maxheight ? Number(p.maxheight) : null,
      },
      station: p.station ? { place: p.station === 'ils-side' ? 'side' : 'edge', stack: Number(p.pile || 1), slots: { warper: p.warper === '1', keepFree: p.proslot !== '0' && Number(p.spray || 0) > 0 } } : null,
      power: p.power || null,
      burn: Array.isArray(p.burn) && p.burn.length ? p.burn.map(Number) : false, // 要就地烧掉的副产物（「外部供应」弹窗里选，plan/burn.js）
      orient: p.orient || 'h',
      onRound,
    };
    if (preview) {
      options.snapshotMs = 500; // 实时预览：每半秒报一次步数（实测估时用），绘图模型最多一秒一份
      if (!helpers) {
        // 单线程回退：就地装快照钩子（多线程时帮手线程自己装，见 onmessage 的 task 分支）
        const st = { last: 0, bestRef: null, space: null };
        options.onSnapshot = (snap) => preview.take({ gen: 1, options }, snapshotPayload(snap, st));
      }
    }
    once = async (o) => {
      try {
        return helpers ? await planLineAsync(calc, o, helpers) : planLine(calc, o);
      } catch (e) {
        if (!helpers || e.item || taken.has(activeId)) throw e; // 「就这个蓝图了」停掉的：不再重来
        return planLine(calc, o); // 帮手线程中途出错：单线程重来
      }
    };
    plan = module && options.station?.place === 'edge' ? await planModule(once, options) : await once(options);
  } catch (e) {
    return { error: e.message, suggestRaw: e.item ?? null };
  }
  // 规划器觉得达标了、出蓝图后检查却没过，总时限内换种子重排（最多 3 次），留过了的那张
  if (effort.untilTarget && !module) {
    const blueprintOk = (pl) => {
      const r = emitBlueprint(pl.graph, pl.layout, { belt: Number(p.belt), sorter: Number(p.sorter) });
      return !r.issues.length && checkBlueprint(r.str).ok;
    };
    const stopAt = Date.now() + effort.untilTarget.maxMs - (plan.ms ?? 0);
    for (let k = 1; k <= 3 && plan.targetMet && !blueprintOk(plan) && stopAt - Date.now() > 5000; k++) {
      try {
        // 重排只能用总时限剩下的时间（不然每次重排又领一份完整的时限）
        const again = await once({ ...options, seed: 7 + 4099 * k, untilTarget: { maxMs: Math.max(0, stopAt - Date.now()) } });
        if (again.targetMet) plan = { ...again, ms: (plan.ms ?? 0) + (again.ms ?? 0) };
      } catch {
        break;
      }
    }
  }
  return describePlan(plan, calc, p, effort, helpers ? helpers.size : 1);
}

/** 规划结果 → 页面要的结果：出蓝图、独立检查、各种数字和说明（搜完的，或「就这个蓝图了」收尾的） */
function describePlan(plan, calc, p, effort, threadCount) {
  const L = plan.layout;
  const v = validate(plan.graph, L);
  const text = blueprintText(L, calc.label);
  const { str, issues } = emitBlueprint(plan.graph, L, { belt: Number(p.belt), sorter: Number(p.sorter), ...text, targetId: calc.targetId, icons: calc.targets.map((t) => t.itemId) });
  const check = checkBlueprint(str);
  return {
    target: calc.target,
    rate: calc.rate,
    title: calc.targets.map((t) => `${t.name} ${t.rate}/分`).join(' + '),
    ms: plan.ms,
    threads: threadCount,
    picked: plan.picked ?? null, // 搜索中途按「就这个蓝图了」交出来的：第几轮
    // 达没达标和页面上的「检查通过」同一个标准：可行、独立检查和出蓝图都没问题，再加利用率到这一档
    goal: { met: plan.targetMet !== false && !!L.feasible && check.ok && !issues.length, space: L.space.space, target: effort.targetSpace, feasible: !!L.feasible, rounds: plan.searchRounds, stalled: !!plan.stalled },
    metrics: {
      ...blueprintSize(L), // 竖排时出出来的蓝图转了 90°，宽长对调
      orient: plan.orientTried?.length > 1 || plan.orient === 'v' ? { used: plan.orient, alt: plan.orientAlt ? { ...plan.orientAlt, ...(plan.orientAlt.rotated ? { width: plan.orientAlt.height, height: plan.orientAlt.width } : {}) } : null } : null,
      area: L.area,
      belts: L.belts,
      sorters: L.sorters,
      factories: L.factories,
      airBelts: L.airBelts,
      lifted: L.legs.filter((l) => l.cells.length).length,
      maxLevel: Math.max(0, ...L.legs.map((l) => (l.cells.length ? l.level : 0))),
      roads: L.roads,
      fill: L.fill,
      space: L.space,
      longestBelt: L.longestBelt,
      sorterLengths: L.sorterLengths,
      target: plan.targetSpace,
      searchRounds: plan.searchRounds,
      stationFallback: !!plan.stationFallback,
      moduleRetries: plan.moduleRetries ?? 0,
      power: L.power
        ? {
            name: L.power.name,
            count: L.power.nodes.length,
            ext: Object.entries(L.power.extend).filter(([, v]) => v).map(([k, v]) => `${{ left: '左', right: '右', bottom: '下', top: '上' }[k]} ${v} 格`).join('、'),
          }
        : null,
    },
    groups: plan.graph.groups.map((g) => ({ letter: g.letter, item: g.item, factory: g.factory, count: g.count, levels: g.levels ?? 1 })),
    // 就地烧掉的副产物（plan/burn.js）：烧什么、每分钟多少、几台火力发电厂、满负荷发多少电；没烧成的原因
    burn: (L.burners || []).map((b) => ({ item: ITEMS.get(b.itemId).name, rate: b.rate, plants: b.plants.length, mw: b.mw, cols: b.cols, depth: b.depth })),
    burnNotes: L.burnNotes ?? [],
    // 化工厂按赤道压缩的间距排的（页面检查栏写一句：只在赤道附近放得下）
    latitude: (() => {
      const g = plan.graph.groups.find((x) => hasHighLatitude(x.factoryId));
      return g ? { factory: g.factory, high: g.latitude === 'high' } : null;
    })(),
    byproducts: calc.byproducts.map((b) => ({ name: b.item, rate: b.rate, of: ITEMS.get(b.of).name })),
    recipes: calc.units.filter((u) => recipeChoices(u.itemId)[0]?.id !== u.recipeId).map((u) => ({ item: u.item, recipe: u.recipe })),
    addons: {
      spray: calc.spray ? { name: calc.spray.name, rate: calc.spray.rate, units: calc.units.filter((u) => u.spray).map((u) => `${u.item}（${u.spray.mode === 'extra' ? `增产 +${Math.round((u.spray.outMul - 1) * 1000) / 10}%` : `加速 +${Math.round((u.spray.speedMul - 1) * 100)}%`}）`) } : null,
      coaters: L.coaters?.length ?? 0,
      pilers: L.pilers?.length ?? 0,
      notes: [...(L.addonNotes ?? []), ...(L.warperNotes ?? [])],
      // 翘曲器整张一格（plan/stations.js 的 linkWarpers）：哪座站存、送到哪几座
      warper: (L.stations || []).some((st) => st.items.some((it) => it.role === 'warper'))
        ? { home: (L.stations || []).findIndex((st) => st.items.some((it) => it.role === 'warper')) + 1, to: (L.warperLinks || []).map((w) => w.to.k + 1) }
        : null,
      lines: (L.proLines || []).map((pl) => (pl.station ? `物流站 ${pl.station.k + 1} 的 ${pl.station.slot} 号口` : `边缘第 ${pl.edge[1] + (L.origin?.y ?? 0)} ${L.rotated ? '列' : '行'}的入口`)),
    },
    model: renderModel(plan.graph, L),
    ports: ports(plan.graph, L),
    stations: (L.stations || []).map((st) => ({
      ...toBlueprint(L, st.x + (L.origin?.x ?? 0), st.y + (L.origin?.y ?? 0)),
      items: st.items.map((it) => ({ name: ITEMS.get(it.itemId)?.name ?? plan.graph.items.get(it.itemId)?.name ?? String(it.itemId), role: it.role })),
      ports: st.ports.map((p) => ({ slot: p.slot, dir: p.dir, item: plan.graph.items.get(p.itemId)?.name ?? ITEMS.get(p.itemId)?.name ?? String(p.itemId) })),
    })),
    penalties: L.penalties.filter((x) => x.kind !== 'fill' && x.kind !== 'long').map((x) => ({ kind: x.kind, msg: x.msg })).concat((L.power?.warnings || []).map((msg) => ({ kind: 'power', msg }))), // 土地利用率在「检查」里单独说；带长先不考虑
    feasible: L.feasible,
    validate: { ok: v.ok, errors: v.errors.slice(0, 10) },
    check: { ok: check.ok && !issues.length, errors: [...issues, ...check.errors].slice(0, 12), warnings: check.warnings },
    blueprint: str,
    energy: energyOf(calc, L, p),
  };
}

/** 用电：数值和要显示的文字都在后台算好（页面不引游戏数据） */
function energyOf(calc, L, p) {
  const e = powerDemand(calc, L, { sorter: Number(p.sorter) });
  return { ...e, text: powerText(e), totalText: fmtWatts(e.total), detail: `${e.byFactory.map((f) => `${f.name} ${f.count} 台 ${fmtWatts(f.watts)}`).join('、')}${e.stations ? `；物流站充电另算，最多 ${fmtWatts(e.stationCharge)}` : ''}` };
}

/** 分馏塔阵列：结果的字段和普通产线一样，页面照常画图、出检查和说明 */
function fractionRun(rate, spray = 0) {
  const t0 = performance.now();
  const r = fractionatorArray(rate, { spray });
  const check = checkArray(r.str);
  const model = arrayModel(r);
  const B = r.buildings;
  const isBelt = (b) => b.itemId >= 2001 && b.itemId <= 2003;
  const belts = B.filter(isBelt);
  const ground = new Set();
  const K = (x, y) => `${Math.round(x)},${Math.round(y)}`;
  for (const b of B) {
    const o = b.localOffset[0];
    const h = b.itemId === 2104 ? 3 : b.itemId === 2314 ? 1 : 0;
    if (isBelt(b) && o.z > 0.25) continue;
    for (let dx = -h; dx <= h; dx++) for (let dy = -h; dy <= h; dy++) ground.add(K(o.x + dx, o.y + dy));
  }
  const area = r.width * r.height;
  const st = B.find((b) => b.itemId === 2104);
  const role = (n) => (n === 1 ? 'supply' : 'demand');
  const names = { 1120: '氢', 1121: '重氢', 1143: '增产剂 Mk.III', 1210: '空间翘曲器' };
  const storage = st.parameters.storage;
  const towers = B.filter((b) => b.itemId === 2201).length;
  return {
    target: '重氢',
    rate: r.fracs * r.plan.perTower,
    title: `重氢 ${rate}/分 · 分馏塔阵列`,
    ms: Math.round(performance.now() - t0),
    threads: 1,
    metrics: {
      width: r.width,
      height: r.height,
      area,
      belts: belts.length,
      sorters: 0,
      factories: r.fracs,
      airBelts: belts.filter((b) => b.localOffset[0].z > 0.25).length,
      lifted: 0,
      maxLevel: 2,
      roads: null,
      fill: 1,
      space: { space: ground.size / area, factory: (r.fracs * 9) / area, rows: 1 },
      longestBelt: 0,
      sorterLengths: {},
      power: { name: '电力感应塔', count: towers, ext: '' },
    },
    groups: [...new Set(model.rows.flatMap((row) => row.groups.map((g) => g.letter)))].sort().map((k) => ({ letter: k, item: '重氢', factory: '分馏塔', count: model.rows.reduce((n, row) => n + row.groups.filter((g) => g.letter === k).length, 0) })),
    byproducts: [],
    recipes: [{ item: '重氢', recipe: '重氢分馏（分馏塔阵列）' }],
    model,
    ports: [],
    stations: [{
      x: Math.round(st.localOffset[0].x),
      y: Math.round(st.localOffset[0].y),
      items: storage.filter((s) => s.itemId).map((s) => ({ name: names[s.itemId] ?? ITEMS.get(s.itemId)?.name ?? String(s.itemId), role: role(s.localRole) })),
      ports: st.parameters.slots.map((sl, slot) => ({ slot, sl })).filter(({ sl }) => sl.dir).map(({ slot, sl }) => ({ slot, dir: sl.dir === 1 ? 'out' : 'in', item: names[storage[sl.storageIdx - 1]?.itemId] ?? '' })),
    }],
    penalties: [],
    feasible: true,
    validate: { ok: true, errors: [] },
    check: { ok: check.ok, errors: check.errors.slice(0, 12), warnings: check.warnings },
    blueprint: r.str,
    array: { notes: r.notes, plan: r.plan, fracs: r.fracs },
  };
}

/**
 * 快照 → 发给上层的消息体：步数、温度、代价每次都带；绘图模型（几十 KB）最多一秒一份，
 * 其余时候只带数字（半秒一报，给实测估时用）。转模型失败只丢这一份预览，绝不影响搜索。
 * space：这一轮目前最好那张的空间利用率（自动模式按它挑看哪一轮）；最好那张不可行时为 null。最好那张换了才重算
 */
function snapshotPayload(snap, state) {
  if (snap.best !== state.bestRef) {
    state.bestRef = snap.best;
    try {
      state.space = snap.best?.feasible ? spaceStats(snap.best).space : null;
    } catch {
      state.space = null;
    }
  }
  let model = null;
  if (Date.now() - state.last >= 1000) {
    state.last = Date.now();
    try {
      model = renderModel(snap.graph, snap.layout);
    } catch {
      model = null;
    }
  }
  // 带图的那份也带上它的布局（「就这个蓝图了」直接拿它收尾；大小和绘图模型差不多，几十到一百多 KB）
  return { s: snap.s, i: snap.i, iterations: snap.iterations, T: snap.T, cost: snap.cost, best: snap.bestCost, space: state.space, feasible: snap.feasible, model, layout: model ? snap.layout : null };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  // 帮手线程：只管跑分来的活
  if (msg.type === 'task') {
    // 实时预览：搜索任务带了 snapshotMs 开关时在这里装快照钩子（回调传不过线程，只能本地装）。
    // 快照走 { id, progress } 消息发回总调度线程，别和任务完成 { id, result } 弄混
    if (msg.task.kind === 'search' && msg.task.options?.snapshotMs > 0) {
      const st = { last: 0, bestRef: null, space: null };
      msg.task.options.onSnapshot = (snap) => {
        try {
          self.postMessage({ id: msg.id, progress: snapshotPayload(snap, st) });
        } catch {
          /* 预览发不出去就算了，搜索照常 */
        }
      };
    }
    try {
      self.postMessage({ id: msg.id, result: msg.task.kind === 'ping' ? 'pong' : runTask(msg.task) });
    } catch (e) {
      self.postMessage({ id: msg.id, error: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'init') {
    try {
      helperUrl = URL.createObjectURL(new Blob([msg.src], { type: 'text/javascript' }));
    } catch {
      helperUrl = null;
    }
    threads = Math.max(1, Math.min(16, Number(msg.threads) || 1));
    return;
  }
  if (msg.type === 'watch') {
    // 页面切换观摩哪一轮：round 为 null 是自动（看目前最好的那一轮）
    if (curPreview && curPreview.id === msg.id) {
      curPreview.watch = msg.round == null ? 'auto' : Number(msg.round);
      curPreview.forceNext = true; // 点了就马上给一张，不等下一个 25 秒
    }
    return;
  }
  try {
    if (msg.type === 'catalog') self.postMessage({ type: 'catalog', id: msg.id, list: catalog(msg.raw || []) });
    else if (msg.type === 'chain') self.postMessage({ type: 'chain', id: msg.id, data: chain(msg.params) });
    else if (msg.type === 'plan') {
      const data = await run(msg.params, msg.id);
      if (!taken.has(msg.id)) self.postMessage({ type: 'result', id: msg.id, data });
    } else if (msg.type === 'take') takeShown(msg.id);
  } catch (e) {
    if (!taken.has(msg.id)) self.postMessage({ type: 'result', id: msg.id, data: { error: e.message } });
  }
};
