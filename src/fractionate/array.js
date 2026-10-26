// 分馏塔阵列（做重氢）：从用户 2026-10-04 给的、游戏里在用的 60 塔阵列（template.js）裁剪出来，不重新排。
//
// 原图 36×73，右边中间一座星际物流站，上下两半，每半两组「对列」，一共四个氢循环：
//   一组对列 = 左列 8 座分馏塔（朝右，氢从下往上穿过）+ 右列 7 座（朝左，氢从上往下穿过），两列中间一条收集带，
//   两边分馏塔侧面出来的重氢都汇进去。氢在一组对列里绕一圈：出右列后过两台自动集装机重新叠成 4 层，
//   和站里新送来的氢（先过喷涂机喷增产剂、再过两台集装机）汇合，再进左列。
//   每半边两条收集带各过一台集装机，在四向分流器汇成一条，喷上增产剂进站。
//   分馏塔的口：1 号是输入（背面），2 号是直通（正面，没分馏的氢接着往下一座走），0 号是产物（侧面，重氢）。
//
// 生成时：按要的重氢产量算塔数 → 挑几个循环（离站最近的先用）→ 每个循环留最靠近站的塔、多余的换成直带 →
// 删掉没用的循环、站口、电塔 → 压紧（compact.js：删只剩直带的行、列，站往循环那边剪切，删多余电塔、重放电塔，每步查建造盒碰撞）→
// 裁掉空出来的边 → 比宽还长就转 90°。有宽、长、长宽比上限时每份从 4 个循环往少了试，取第一个放得下的。
import { fromStr, toStr } from '../codec/parser.js';
import { POWER, powerReach } from '../plan/power.js';
import { rotateBlueprint } from '../emit/rotate.js';
import { TEMPLATE } from './template.js';
import { compact, collisions } from './compact.js';

const ST = 2104;
const FRAC = 2314;
const PILER = 2040;
const COATER = 2313;
const SPLIT = 2020;
const TESLA = 2201;
const H = 1120; // 氢
const D = 1121; // 重氢
const PRO = 1143; // 增产剂 Mk.III
const isBelt = (b) => b.itemId >= 2001 && b.itemId <= 2003;
const R = (b) => ({ x: Math.round(b.localOffset[0].x), y: Math.round(b.localOffset[0].y), z: Math.round(b.localOffset[0].z) });

/** 站的出站口 → 循环。上半：9 号口接左边一组（A），8 号口接右边一组（B）；下半：11 号口（C）、0 号口（D） */
export const LOOPS = [
  { key: 'B', slot: 8, half: 'U', name: '上半右组' },
  { key: 'A', slot: 9, half: 'U', name: '上半左组' },
  { key: 'D', slot: 0, half: 'L', name: '下半右组' },
  { key: 'C', slot: 11, half: 'L', name: '下半左组' },
];
const SLOT_IN = { U: 7, L: 1 }; // 重氢进站口
const SLOT_PRO = 5; // 增产剂出站口
export const TOWERS_PER_LOOP = 15;
export const MAX_TOWERS = TOWERS_PER_LOOP * LOOPS.length;
/**
 * 每座分馏塔每分钟出多少重氢 = 流过它的氢 × 分馏概率。
 *   流速：极速带集装 4 层 7200/分（用户 2026-10-04 实测单塔接近 7200/分）。
 *   概率：不喷 1%；喷增产剂按「加速」算，Mk.I 1.25%、Mk.II 1.5%（用户实测）、Mk.III 2%（BWIKI）。
 * 用户原图 60 塔、站里存的是 Mk.III，统计约 8640/分 = 60 × 7200 × 2%。
 */
export const FLOW = 7200;
export const SPRAY = [
  { level: 0, name: '不喷', item: 0, p: 0.01 },
  { level: 1, name: '增产剂 Mk.I', item: 1141, p: 0.0125 },
  { level: 2, name: '增产剂 Mk.II', item: 1142, p: 0.015 },
  { level: 3, name: '增产剂 Mk.III', item: 1143, p: 0.02 },
];
export const perTowerOf = (spray = 3) => FLOW * SPRAY[spray].p;
export const PER_TOWER = perTowerOf(3);

/** 解析原图：给每座建筑标上它属于哪个循环（A~D）、哪半边共用（U/L）、增产剂（P）、站（S）或电塔（T） */
export function analyzeTemplate(B) {
  const station = B.find((b) => b.itemId === ST);
  const fedBy = new Map(); // 设备 → 它送出的带子
  for (const b of B) if (isBelt(b) && b.inputObjIdx >= 0) (fedBy.get(b.inputObjIdx) ?? fedBy.set(b.inputObjIdx, []).get(b.inputObjIdx)).push(b);
  const preds = new Map(); // 带子 → 前一节带子
  for (const b of B) if (isBelt(b) && b.outputObjIdx >= 0 && isBelt(B[b.outputObjIdx])) (preds.get(b.outputObjIdx) ?? preds.set(b.outputObjIdx, []).get(b.outputObjIdx)).push(b);
  const tag = new Map();
  const next = (b, slots) => (isBelt(b) ? (b.outputObjIdx >= 0 ? [B[b.outputObjIdx]] : []) : (fedBy.get(b.index) ?? []).filter((x) => !slots || slots.includes(x.inputFromSlot)));
  const walk = (starts, t, { stop = () => false, fracSlots = [2] } = {}) => {
    const seen = [];
    const st = [...starts];
    while (st.length) {
      const b = st.pop();
      if (tag.has(b.index) || b.itemId === ST || stop(b)) continue;
      tag.set(b.index, t);
      seen.push(b);
      st.push(...next(b, b.itemId === FRAC ? fracSlots : null));
    }
    return seen;
  };
  const loops = new Map();
  for (const lp of LOOPS) {
    const starts = (fedBy.get(station.index) ?? []).filter((b) => b.inputFromSlot === lp.slot);
    const hNet = walk(starts, lp.key);
    const fracs = hNet.filter((b) => b.itemId === FRAC);
    loops.set(lp.key, { ...lp, entry: starts, fracs, order: [] });
  }
  // 重氢：每座塔 0 号口出来，到四向分流器为止归这个循环；分流器到站归半边共用
  for (const lp of loops.values()) {
    for (const f of lp.fracs) walk((fedBy.get(f.index) ?? []).filter((b) => b.inputFromSlot === 0), lp.key, { stop: (b) => b.itemId === SPLIT });
  }
  for (const x of B.filter((b) => b.itemId === SPLIT)) {
    const into = B.filter((b) => isBelt(b) && b.outputObjIdx === x.index).map((b) => tag.get(b.index));
    const half = LOOPS.find((l) => into.includes(l.key))?.half ?? '?';
    walk([x], half);
  }
  walk((fedBy.get(station.index) ?? []).filter((b) => b.inputFromSlot === SLOT_PRO), 'P');
  tag.set(station.index, 'S');
  // 喷涂机按它压着的那节带子归属；电塔单独处理
  const beltAt = new Map();
  for (const b of B) if (isBelt(b) && R(b).z === 0) beltAt.set(`${R(b).x},${R(b).y}`, b);
  for (const b of B) {
    if (b.itemId === COATER) tag.set(b.index, tag.get(beltAt.get(`${R(b).x},${R(b).y}`)?.index) ?? '?');
    if (b.itemId === TESLA) tag.set(b.index, 'T');
  }
  // 每个循环里分馏塔的先后：从入口那座起，顺着 2 号口（直通）一座接一座
  for (const lp of loops.values()) {
    const set = new Set(lp.fracs.map((f) => f.index));
    const has = new Set(lp.fracs.map((f) => f.index));
    // 入口那座：从站口出发、不经过别的分馏塔最先到的那座
    let first = null;
    {
      const st = [...lp.entry];
      const seen = new Set();
      while (st.length && !first) {
        const b = st.shift();
        if (seen.has(b.index)) continue;
        seen.add(b.index);
        if (b.itemId === FRAC && has.has(b.index)) first = b;
        else if (b.itemId !== FRAC) st.push(...next(b));
      }
    }
    let cur = first;
    while (cur && set.has(cur.index)) {
      lp.order.push(cur);
      set.delete(cur.index);
      let b = (fedBy.get(cur.index) ?? []).find((x) => x.inputFromSlot === 2);
      cur = null;
      while (b && isBelt(b)) b = b.outputObjIdx >= 0 ? B[b.outputObjIdx] : null;
      if (b && b.itemId === FRAC) cur = b;
    }
  }
  const untagged = B.filter((b) => !tag.has(b.index));
  return { station, tag, loops, fedBy, preds, untagged };
}

/** 要 n 座塔：分几份粘贴、每份几座、用哪几个循环、每个循环几座；maxLoops：每份最多几个循环（尺寸上限放不下时往少了试） */
export function arrayPlan(rate, perTower = PER_TOWER, maxLoops = LOOPS.length) {
  const towers = Math.max(1, Math.ceil(rate / perTower - 1e-9));
  const copies = Math.ceil(towers / (TOWERS_PER_LOOP * maxLoops));
  const per = Math.ceil(towers / copies);
  const nLoops = Math.ceil(per / TOWERS_PER_LOOP);
  const base = Math.floor(per / nLoops);
  const extra = per % nLoops;
  const loops = LOOPS.slice(0, nLoops).map((l, i) => ({ key: l.key, towers: base + (i < extra ? 1 : 0) }));
  return { towers, copies, per, loops, perTower, rate: per * perTower * copies };
}

/**
 * 生成分馏阵列蓝图。
 * @param {number} rate 想要的重氢产量（个/分钟）
 * @param {object} [o]
 * @param {number} [o.spray=3] 氢喷什么增产剂：0 不喷，1~3 Mk.I~Mk.III（决定分馏概率和站里存哪种增产剂）
 * @param {number} [o.perTower] 每座塔每分钟出多少重氢（默认 7200 × 概率）
 * @param {'h'|'v'} [o.orient='h'] 'h' 横着出：比宽还长就整张顺时针转 90°（同 emit/rotate.js），站到下边；'v' 照原图竖着
 * @param {number} [o.maxWidth] [o.maxHeight] [o.maxAspect] 出出来的宽、长、长边比短边的上限：每份从 4 个循环往少了试，取第一个放得下的；
 *   都放不下就用 1 个循环的那种、notes 里说一声。plan.limits 记着上限、试过哪几种、被哪条卡住
 * @returns {{str: string, plan: object, buildings: object[], width: number, height: number, tags: Map, notes: string[], rotated: boolean}}
 */
export function fractionatorArray(rate, { spray = 3, perTower = perTowerOf(spray), title, orient = 'h', maxWidth = null, maxHeight = null, maxAspect = null } = {}) {
  const over = (r) => [
    maxWidth != null && r.width > maxWidth && 'width',
    maxHeight != null && r.height > maxHeight && 'height',
    maxAspect != null && Math.max(r.width, r.height) / Math.min(r.width, r.height) > maxAspect + 1e-9 && 'aspect',
  ].filter(Boolean);
  const tried = [];
  let r;
  for (let k = LOOPS.length; k >= 1; k--) {
    const plan = arrayPlan(rate, perTower, k);
    if (tried.some((t) => t.copies === plan.copies)) continue; // 份数一样就是同一种
    r = buildArray(plan, { spray, perTower, title, orient });
    tried.push({ loops: plan.loops.length, copies: plan.copies, per: plan.per, width: r.width, height: r.height, over: over(r) });
    if (!tried.at(-1).over.length) break;
  }
  const p = r.plan;
  const first = tried[0], last = tried.at(-1);
  const fit = !last.over.length;
  const say = (names) => [...new Set(names)].map((k) => ({ width: `宽度上限 ${maxWidth} 格`, height: `长度上限 ${maxHeight} 格`, aspect: `长宽比上限 ${maxAspect} ` })[k]).join('、').replace(/ 、/g, '、');
  const split = `要 ${p.towers} 座，这张图粘贴 ${p.copies} 份（每份 ${p.per} 座）。`;
  p.limits = maxWidth == null && maxHeight == null && maxAspect == null ? null : { maxWidth, maxHeight, maxAspect, fit, by: [...new Set(tried.flatMap((t) => t.over))], tried };
  if (!fit) r.notes.unshift(`${say(last.over)}内放不下一个氢循环（最小 ${last.width}×${last.height}）。${p.copies > 1 ? split : ''}`);
  else if (last !== first) r.notes.unshift(`${say(tried.slice(0, -1).flatMap((t) => t.over))}放不下 ${first.loops} 个循环（${first.width}×${first.height}），每份改用 ${p.loops.length} 个循环。${split}`);
  else if (p.copies > 1) r.notes.unshift(`一座物流站最多带 ${MAX_TOWERS} 座塔（4 个循环）。${split}`);
  return r;
}

/** 按 plan 裁一份 */
function buildArray(plan, { spray, perTower, title, orient }) {
  const bp = fromStr(TEMPLATE);
  const B = bp.buildings;
  const A = analyzeTemplate(B);
  if (A.untagged.length) throw new Error(`分馏阵列模板有 ${A.untagged.length} 座建筑没归到循环里`);
  const keep = new Set(plan.loops.map((l) => l.key));
  const halves = new Set(LOOPS.filter((l) => keep.has(l.key)).map((l) => l.half));
  const removed = new Set();
  for (const b of B) {
    const t = A.tag.get(b.index);
    if (LOOPS.some((l) => l.key === t) && !keep.has(t)) removed.add(b.index);
    if ((t === 'U' || t === 'L') && !halves.has(t)) removed.add(b.index);
  }
  // 不喷增产剂：喷涂机和增产剂带都不要
  if (!spray) for (const b of B) if (b.itemId === COATER || A.tag.get(b.index) === 'P') removed.add(b.index);
  // 每个循环留离站最近的塔：氢往外走的那列（8 座）取前一半、往回走的那列（7 座）取后面剩下的，其余换成直带
  const added = [];
  const replaced = [];
  for (const { key, towers } of plan.loops) {
    const lp = A.loops.get(key);
    const kL = Math.min(8, Math.ceil(towers / 2));
    const keepT = new Set([...lp.order.slice(0, kL), ...lp.order.slice(lp.order.length - (towers - kL))].map((f) => f.index));
    for (const f of lp.order.filter((f) => !keepT.has(f.index)).reverse()) {
      const inB = B.find((b) => isBelt(b) && b.outputObjIdx === f.index);
      const outB = (A.fedBy.get(f.index) ?? []).find((b) => b.inputFromSlot === 2);
      // 侧面 0 号口出来、并进收集带之前的那几节带子一起删掉
      let p = (A.fedBy.get(f.index) ?? []).find((b) => b.inputFromSlot === 0);
      while (p && isBelt(p) && (A.preds.get(p.index)?.length ?? 0) <= 1) {
        removed.add(p.index);
        p = p.outputObjIdx >= 0 ? B[p.outputObjIdx] : null;
      }
      removed.add(f.index);
      const nb = structuredClone(inB);
      nb.index = B.length + added.length;
      const c = R(f);
      const z = inB.localOffset[0].z;
      nb.localOffset = [{ x: c.x, y: c.y, z }, { x: c.x, y: c.y, z }];
      nb.inputObjIdx = -1;
      nb.inputFromSlot = 0;
      nb.outputObjIdx = outB.index;
      nb.outputToSlot = 1;
      added.push(nb);
      inB.outputObjIdx = nb.index;
      inB.outputToSlot = 1;
      outB.inputObjIdx = -1;
      outB.inputFromSlot = 0;
      for (const b of [inB, outB]) for (const o of b.localOffset) { o.x = Math.round(o.x); o.y = Math.round(o.y); }
      replaced.push(c);
      A.tag.set(nb.index, key);
    }
  }
  const all = [...B, ...added];
  // 站：删掉的循环的出站口、删掉的半边的进站口关掉
  const station = all.find((b) => b.itemId === ST);
  for (const l of LOOPS) if (!keep.has(l.key)) station.parameters.slots[l.slot] = { dir: 0, storageIdx: 0 };
  for (const [half, slot] of Object.entries(SLOT_IN)) if (!halves.has(half)) station.parameters.slots[slot] = { dir: 0, storageIdx: 0 };
  // 增产剂：站里那一格换成选的等级；不喷就清掉那一格和 5 号口
  const proIdx = station.parameters.storage.findIndex((x) => x.itemId === PRO);
  if (proIdx >= 0) {
    if (spray) station.parameters.storage[proIdx] = { ...station.parameters.storage[proIdx], itemId: SPRAY[spray].item };
    else {
      station.parameters.storage[proIdx] = { itemId: 0, localRole: 0, remoteRole: 0, max: 0, lockAmount: 0 };
      station.parameters.slots[SLOT_PRO] = { dir: 0, storageIdx: 0 };
    }
  }
  // 增产剂带是一条死路，沿途的喷涂机从它上面取料：最后一台留下的喷涂机之后多留一节，后面的删掉
  {
    const pro = [];
    let b = spray ? all.find((x) => isBelt(x) && x.inputObjIdx === station.index && x.inputFromSlot === SLOT_PRO) : null;
    while (b && isBelt(b) && !pro.includes(b)) {
      pro.push(b);
      b = b.outputObjIdx >= 0 ? all[b.outputObjIdx] : null;
    }
    let last = -1;
    for (const c of all.filter((x) => x.itemId === COATER && !removed.has(x.index))) {
      const i = pro.findIndex((q) => Math.abs(R(q).x - R(c).x) + Math.abs(R(q).y - R(c).y) <= 1);
      last = Math.max(last, i);
    }
    if (last >= 0 && last + 1 < pro.length - 1) {
      for (const q of pro.slice(last + 2)) removed.add(q.index);
      pro[last + 1].outputObjIdx = -1;
      pro[last + 1].outputToSlot = 0;
    }
  }
  // 电塔：留下覆盖得到用电建筑的；再补回连通需要的
  const reach = powerReach('tesla');
  const powered = all.filter((b) => !removed.has(b.index) && [FRAC, PILER, COATER, SPLIT, ST].includes(b.itemId));
  const towers = all.filter((b) => b.itemId === TESLA);
  const d2 = (a, b) => (R(a).x - R(b).x) ** 2 + (R(a).y - R(b).y) ** 2;
  const useful = new Set(towers.filter((t) => powered.some((p) => d2(t, p) <= reach.cover ** 2)).map((t) => t.index));
  const connected = (set) => {
    const list = towers.filter((t) => set.has(t.index));
    if (!list.length) return true;
    const seen = new Set([list[0].index]);
    const st = [list[0]];
    while (st.length) {
      const a = st.pop();
      for (const b of list) if (!seen.has(b.index) && d2(a, b) <= reach.link ** 2) { seen.add(b.index); st.push(b); }
    }
    return seen.size === list.length;
  };
  for (let guard = 0; !connected(useful) && guard < towers.length; guard++) {
    // 补一座离已留电塔最近、能接上的
    const cand = towers.filter((t) => !useful.has(t.index)).sort((a, b) => Math.min(...[...useful].map((i) => d2(a, all[i]))) - Math.min(...[...useful].map((i) => d2(b, all[i]))))[0];
    if (!cand) break;
    useful.add(cand.index);
  }
  for (const t of towers) if (!useful.has(t.index)) removed.add(t.index);
  compact(all, removed, A.tag);
  // 重新编号、修链接
  const kept = all.filter((b) => !removed.has(b.index));
  const map = new Map(kept.map((b, i) => [b.index, i]));
  const tags = new Map();
  for (const b of kept) {
    tags.set(map.get(b.index), A.tag.get(b.index));
    b.index = map.get(b.index);
    if (b.outputObjIdx >= 0) b.outputObjIdx = map.has(b.outputObjIdx) ? map.get(b.outputObjIdx) : -1;
    if (b.inputObjIdx >= 0) b.inputObjIdx = map.has(b.inputObjIdx) ? map.get(b.inputObjIdx) : -1;
  }
  // 裁边：所有建筑（分馏塔按 3×3、物流站按 7×7）的范围平移到从 0 开始
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of kept) {
    const p = R(b);
    const h = b.itemId === ST ? 3 : b.itemId === FRAC ? 1 : 0;
    x0 = Math.min(x0, p.x - h); y0 = Math.min(y0, p.y - h);
    x1 = Math.max(x1, p.x + h); y1 = Math.max(y1, p.y + h);
  }
  for (const b of kept) for (const o of b.localOffset) { o.x -= x0; o.y -= y0; }
  bp.buildings = kept;
  bp.dragBoxSize = { x: x1 - x0 + 1, y: y1 - y0 + 1 };
  bp.cursorOffset = { x: Math.floor(bp.dragBoxSize.x / 2), y: Math.floor(bp.dragBoxSize.y / 2) };
  bp.areas = [{ ...bp.areas[0], size: { ...bp.dragBoxSize } }];
  // 横着出：比宽还长就整张顺时针转 90°（朝向加 90°，站口、连接不变），站到下边
  const rotated = orient === 'h' && bp.dragBoxSize.y > bp.dragBoxSize.x;
  if (rotated) rotateBlueprint(bp);
  const { x: width, y: height } = bp.dragBoxSize;
  const fracs = kept.filter((b) => b.itemId === FRAC).length;
  bp.header = {
    ...bp.header,
    icons: [D, FRAC, 0, 0, 0],
    time: new Date(),
    shortDesc: title ?? `重氢分馏 ${fracs} 塔`,
    desc: `${width}×${height} 格；分馏塔 ${fracs} 座，${plan.loops.length} 个氢循环；按每座 ${+perTower.toFixed(1)}/分（集装 4 层，${SPRAY[spray].name}）约 ${Math.round(fracs * perTower)}/分。dsp-handcraft 生成`,
  };
  const pct = `${+(SPRAY[spray].p * 100).toFixed(2)}%`;
  const notes = [
    `每座分馏塔按 ${+perTower.toFixed(1)}/分 估算：极速带集装 4 层的氢流过每座塔约 ${FLOW}/分，${spray ? `喷${SPRAY[spray].name}` : '不喷增产剂'}时分馏概率 ${pct}。`,
    spray
      ? `氢从物流站出来先过喷涂机、再过两台自动集装机叠到 4 层；物流站要供氢和${SPRAY[spray].name}（5 号口送去喷涂机），收重氢。`
      : '氢从物流站出来过两台自动集装机叠到 4 层；物流站要供氢，收重氢。',
  ];
  if (replaced.length) notes.push(`有 ${replaced.length} 个塔位换成了直带（氢照样流过）。`);
  return { str: toStr(bp), bp, plan, buildings: kept, tags, width, height, fracs, notes, spray, rotated };
}

/**
 * 分馏阵列的独立检查：索引和链接、带子不重格、每座分馏塔前后都接着带子、
 * 每条重氢都能流回站、每座用电建筑都在电塔覆盖范围内、电塔连成一张网。
 */
export function checkArray(str) {
  const bp = fromStr(str.trim());
  const B = bp.buildings;
  const errors = [];
  const warnings = [];
  const err = (m) => errors.length < 100 && errors.push(m);
  B.forEach((b, i) => {
    if (b.index !== i) err(`建筑 ${i} 的 index 为 ${b.index}`);
    for (const k of ['outputObjIdx', 'inputObjIdx']) if (b[k] < -1 || b[k] >= B.length) err(`建筑 ${i} 的 ${k}=${b[k]} 越界`);
  });
  const W = bp.dragBoxSize.x, Hh = bp.dragBoxSize.y;
  for (const b of B) {
    const p = R(b);
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= Hh) err(`建筑 ${b.index} 在 (${p.x},${p.y})，超出 ${W}×${Hh} 的范围`);
  }
  // 带子：同一位置同一高度只能有一节（集装机、分流器前后的两节挤在同一格里，按精确坐标判断）
  const seen = new Map();
  for (const b of B.filter(isBelt)) {
    const o = b.localOffset[0];
    const k = `${o.x.toFixed(2)},${o.y.toFixed(2)},${o.z.toFixed(2)}`; // 原图的高架有 0.5、1 两种高度，同一格上下叠两条
    if (seen.has(k)) err(`传送带 ${seen.get(k)} 和 ${b.index} 重叠于 ${k}`);
    seen.set(k, b.index);
    if (b.outputObjIdx >= 0) {
      const n = B[b.outputObjIdx];
      const q = n.localOffset[0];
      const dist = Math.hypot(q.x - o.x, q.y - o.y);
      if (isBelt(n) && dist > 1.5 && Math.abs(q.z - o.z) < 0.5) err(`传送带 ${b.index}→${n.index} 不相邻（${dist.toFixed(2)} 格）`);
    }
  }
  const fedBy = new Map();
  for (const b of B) if (isBelt(b) && b.inputObjIdx >= 0) (fedBy.get(b.inputObjIdx) ?? fedBy.set(b.inputObjIdx, []).get(b.inputObjIdx)).push(b);
  const station = B.find((b) => b.itemId === ST);
  if (!station) err('没有物流站');
  for (const f of B.filter((b) => b.itemId === FRAC)) {
    const ins = B.filter((b) => isBelt(b) && b.outputObjIdx === f.index);
    const outs = fedBy.get(f.index) ?? [];
    if (ins.length !== 1) err(`分馏塔 ${f.index} 有 ${ins.length} 条进料带`);
    if (!outs.some((b) => b.inputFromSlot === 2)) err(`分馏塔 ${f.index} 的直通口（2 号）没接带子，氢会堵住`);
    // 重氢顺着带子能流回物流站
    let b = outs.find((x) => x.inputFromSlot === 0);
    if (!b) { err(`分馏塔 ${f.index} 的产物口（0 号）没接带子`); continue; }
    const visited = new Set();
    let ok = false;
    const st = [b];
    while (st.length) {
      const c = st.pop();
      if (visited.has(c.index)) continue;
      visited.add(c.index);
      if (c.itemId === ST) { ok = true; break; }
      if (c.itemId === FRAC) continue; // 重氢不该再进分馏塔
      if (isBelt(c)) { if (c.outputObjIdx >= 0) st.push(B[c.outputObjIdx]); }
      else st.push(...(fedBy.get(c.index) ?? []));
    }
    if (!ok) err(`分馏塔 ${f.index} 出来的重氢流不回物流站`);
  }
  // 供电
  const reach = powerReach('tesla');
  const towers = B.filter((b) => b.itemId === TESLA);
  const need = B.filter((b) => [FRAC, PILER, COATER, SPLIT, ST].includes(b.itemId));
  const d2 = (a, b) => (R(a).x - R(b).x) ** 2 + (R(a).y - R(b).y) ** 2;
  for (const b of need) if (!towers.some((t) => d2(t, b) <= reach.cover ** 2)) err(`建筑 ${b.index}（${{ [FRAC]: '分馏塔', [PILER]: '自动集装机', [COATER]: '喷涂机', [SPLIT]: '四向分流器', [ST]: '物流站' }[b.itemId]}）不在供电范围内`);
  if (towers.length) {
    const seenT = new Set([towers[0].index]);
    const st = [towers[0]];
    while (st.length) {
      const a = st.pop();
      for (const t of towers) if (!seenT.has(t.index) && d2(a, t) <= reach.link ** 2) { seenT.add(t.index); st.push(t); }
    }
    if (seenT.size < towers.length) warnings.push('电力感应塔没有连成一张网');
  }
  return {
    ok: !errors.length,
    errors,
    warnings,
    stats: { width: W, height: Hh, buildings: B.length, fractionators: B.filter((b) => b.itemId === FRAC).length, belts: B.filter(isBelt).length, power: towers.length },
  };
}

/**
 * 建造盒碰撞扫一遍（compact.js 的规则，东西向格宽按 0.85）：转过 90° 的图倒回转之前的坐标、朝向再扫。
 * 转完原来的南北向成了东西向：塔距 4 格在东西向按 0.85 只有 4.27 m，比分馏塔的 4.5 m 窄，连原图转过来都撞（推断；东西向格宽 0.9 以上的赤道附近才干净）。
 * 返回撞的对子 [index, index]
 */
export function arrayCollisions(result) {
  const B = !result.rotated
    ? result.buildings
    : result.buildings.map((b) => ({ ...b, localOffset: [{ x: result.height - 1 - b.localOffset[0].y, y: b.localOffset[0].x, z: b.localOffset[0].z }], yaw: [b.yaw[0] - 90] }));
  return collisions(B);
}

/**
 * 网页画图用的模型：分馏塔、物流站、集装机等小设备、电塔，带子按物品分成一段段逐格路径。
 * 转过 90° 的图（result.rotated）：模型照转之前的坐标、朝向给，标 rotated，网页整组顺时针转 90° 显示（同普通产线的竖排；分馏塔只画得出朝左、朝右）
 */
export function arrayModel(result) {
  const B = result.buildings;
  const tags = result.tags;
  const turned = !!result.rotated;
  // (x, y) → (y, W − 1 − x) 倒回去：W 是转之前的宽，也就是转之后的长
  const pos = (b) => (turned ? { x: result.height - 1 - b.localOffset[0].y, y: b.localOffset[0].x, z: b.localOffset[0].z } : b.localOffset[0]);
  const P = (b) => ({ x: Math.round(pos(b).x), y: Math.round(pos(b).y) });
  const yaw = (b) => (turned ? (((b.yaw[0] - 90) % 360) + 360) % 360 : b.yaw[0]);
  const proId = SPRAY[result.spray ?? 3].item || PRO;
  const itemOf = (b) => (tags.get(b.index) === 'P' ? proId : null);
  // 带子的物品：顺着链子看，接到物流站重氢进站口 / 从分馏塔 0 号口出来的是重氢，增产剂单独，其余是氢
  const item = new Map();
  const fedBy = new Map();
  for (const b of B) if (isBelt(b) && b.inputObjIdx >= 0) (fedBy.get(b.inputObjIdx) ?? fedBy.set(b.inputObjIdx, []).get(b.inputObjIdx)).push(b);
  const paint = (starts, id) => {
    const st = [...starts];
    while (st.length) {
      const b = st.pop();
      if (!isBelt(b) || item.has(b.index)) {
        if (b && (b.itemId === PILER || b.itemId === SPLIT) && !item.has(`d${b.index}`)) { item.set(`d${b.index}`, id); st.push(...(fedBy.get(b.index) ?? [])); }
        continue;
      }
      item.set(b.index, id);
      if (b.outputObjIdx >= 0) st.push(B[b.outputObjIdx]);
    }
  };
  for (const f of B.filter((b) => b.itemId === FRAC)) paint((fedBy.get(f.index) ?? []).filter((b) => b.inputFromSlot === 0), D);
  for (const b of B) if (isBelt(b) && itemOf(b)) item.set(b.index, proId);
  for (const b of B) if (isBelt(b) && !item.has(b.index)) item.set(b.index, H);
  // 逐格路径：从没有前一节带子（或前一节是设备、或是汇流点）的地方起，走到设备或汇流点为止
  const preds = new Map();
  for (const b of B) if (isBelt(b) && b.outputObjIdx >= 0 && isBelt(B[b.outputObjIdx])) preds.set(b.outputObjIdx, (preds.get(b.outputObjIdx) ?? 0) + 1);
  // 楼层：原图的高架有 0.5 和 1 两种高度（同一格上下叠两条），画图时分到 L2、L3
  const cellOf = (b) => [P(b).x, P(b).y, Math.max(0, Math.round(b.localOffset[0].z * 2))];
  const routes = [];
  const used = new Set();
  for (const h of B.filter((b) => isBelt(b) && (preds.get(b.index) ?? 0) !== 1)) {
    const cells = [];
    let c = h;
    while (c && isBelt(c) && !used.has(c.index)) {
      used.add(c.index);
      const p = cellOf(c);
      if (!cells.length || cells.at(-1)[0] !== p[0] || cells.at(-1)[1] !== p[1] || cells.at(-1)[2] !== p[2]) cells.push(p);
      const n = c.outputObjIdx >= 0 ? B[c.outputObjIdx] : null;
      if (n && isBelt(n) && (preds.get(n.index) ?? 0) > 1) {
        cells.push(cellOf(n)); // 画到汇流点那一格，线才接得上
        break;
      }
      c = n;
    }
    if (cells.length) routes.push({ itemId: item.get(h.index), cells, inPort: false, outPort: false });
  }
  const loopLetter = (b) => tags.get(b.index) ?? '';
  const fr = B.filter((b) => b.itemId === FRAC);
  const byY = new Map();
  for (const f of fr) {
    const p = P(f);
    if (!byY.has(p.y)) byY.set(p.y, []);
    byY.get(p.y).push(f);
  }
  const rows = [...byY.entries()].map(([cy, fs]) => ({
    cy,
    groups: fs.map((f) => ({ id: `f${f.index}`, letter: loopLetter(f), item: '重氢', factory: '分馏塔', kind: 'fractionator', count: 1, centers: [P(f).x], below: 1, above: 1, yaw: yaw(f) })),
  }));
  const devices = B.filter((b) => [PILER, COATER, SPLIT].includes(b.itemId)).map((b) => ({ x: P(b).x, y: P(b).y, kind: { [PILER]: 'piler', [COATER]: 'coater', [SPLIT]: 'splitter' }[b.itemId], yaw: yaw(b) }));
  const reach = powerReach('tesla');
  const st = B.find((b) => b.itemId === ST);
  const n = result.fracs * result.plan.perTower;
  return {
    width: turned ? result.height : result.width,
    height: turned ? result.width : result.height,
    rotated: turned,
    origin: { x: 0, y: 0 },
    rows,
    items: { [H]: { name: '氢', letter: 'h', rate: n }, [D]: { name: '重氢', letter: 'd', rate: n }, ...(result.spray ? { [proId]: { name: SPRAY[result.spray].name, letter: 'p', rate: 0 } } : {}) },
    segments: [],
    legs: [],
    sorters: [],
    power: { name: POWER.tesla.name, size: 1, cover: reach.cover, nodes: B.filter((b) => b.itemId === TESLA).map((b) => P(b)) },
    stations: st ? [P(st)] : [],
    stubs: [],
    routes,
    devices,
    streets: [],
    trunk: null,
  };
}
