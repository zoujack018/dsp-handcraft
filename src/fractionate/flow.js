// 分馏阵列的运力核对（稳态，游戏 0.10.35 的 FractionatorComponent 反编译推的，没进游戏量过）：
//   一座塔最多流过 7200/分（极速带集装 4 层），只分走流过的 p，直通口出去的少 p；所以一个氢循环里第 k 座流过 7200·(1−p)^(k−1)，
//   n 座的循环出 7200·(1−(1−p)^n)，不是 n × 7200p。产物口每帧放 1 个单层货物，一条极速带的收集带最多 1800/分。
// 从蓝图的链接认出每个循环（塔 2 号口 → 带 / 集装机 → 下一座塔 1 号口，绕回来）、并带点（新氢从侧面进来的那节）、每座塔 0 号口的带，
// 算每座流过多少、每节收集带压着多少重氢。docs/frac-anneal-design.md 第一节第 3、6 条。
import { fromStr } from '../codec/parser.js';

const FRAC = 2314, PILER = 2040, ST = 2104, SPLIT = 2020;
const isBelt = (b) => b.itemId >= 2001 && b.itemId <= 2003;
export const LOOP_FLOW = 7200;
export const BELT_CAP = 1800;

/** 一个 n 座塔的循环（进第一座的氢 7200/分）每分钟出多少重氢 */
export const loopYield = (n, p) => LOOP_FLOW * (1 - (1 - p) ** n);
/** 一条收集带（极速带单层 1800/分）最多带几座 */
export const maxTowersPerBelt = (p) => {
  let n = 1;
  while (loopYield(n + 1, p) <= BELT_CAP + 1e-9) n++;
  return n;
};

/**
 * 核对一张阵列蓝图（字符串或解码后的建筑数组）：
 * @returns {{ loops: {n, pilers, merges, d, dIdeal}[], total, totalIdeal, maxBelt, maxBeltIdeal, errors: string[] }}
 *   errors：收集带超 1800/分、循环里没有集装机、没有新氢并进来、有塔不在循环上、重氢流不回站
 */
export function flowCheck(input, p) {
  const B = typeof input === 'string' ? fromStr(input.trim()).buildings : input;
  const fedBy = new Map();
  for (const b of B) if (isBelt(b) && b.inputObjIdx >= 0) (fedBy.get(b.inputObjIdx) ?? fedBy.set(b.inputObjIdx, []).get(b.inputObjIdx)).push(b);
  const preds = new Map();
  for (const b of B) if (isBelt(b) && b.outputObjIdx >= 0 && isBelt(B[b.outputObjIdx])) (preds.get(b.outputObjIdx) ?? preds.set(b.outputObjIdx, []).get(b.outputObjIdx)).push(b);
  const towers = B.filter((b) => b.itemId === FRAC);
  const next = new Map();
  for (const t of towers) {
    let b = (fedBy.get(t.index) ?? []).find((x) => x.inputFromSlot === 2);
    const path = { pilers: 0, merges: 0, to: null };
    const seen = new Set();
    while (b && !seen.has(b.index)) {
      seen.add(b.index);
      if ((preds.get(b.index)?.length ?? 0) > 1) path.merges++;
      const o = b.outputObjIdx >= 0 ? B[b.outputObjIdx] : null;
      if (!o) break;
      if (o.itemId === FRAC) { path.to = o; break; }
      if (o.itemId === PILER) { path.pilers++; b = (fedBy.get(o.index) ?? [])[0]; continue; }
      if (!isBelt(o)) break;
      b = o;
    }
    next.set(t.index, path);
  }
  const errors = [];
  const loops = [];
  const done = new Set();
  for (const t of towers) {
    if (done.has(t.index)) continue;
    const order = [];
    let c = t;
    while (c && !order.includes(c)) { order.push(c); c = next.get(c.index)?.to; }
    if (c !== t) continue;
    for (const x of order) done.add(x.index);
    const k = order.findIndex((x) => next.get(x.index).merges > 0);
    const rot = k >= 0 ? [...order.slice(k + 1), ...order.slice(0, k + 1)] : order;
    const pilers = order.reduce((n, x) => n + next.get(x.index).pilers, 0);
    const merges = order.reduce((n, x) => n + next.get(x.index).merges, 0);
    loops.push({ towers: rot, pilers, merges });
    if (!pilers) errors.push(`${order.length} 座塔的循环里没有集装机，回程的氢叠不回 4 层、新氢并不进去`);
    if (!merges) errors.push(`${order.length} 座塔的循环没有新氢并进来`);
  }
  if (done.size < towers.length) errors.push(`${towers.length - done.size} 座塔不在氢循环上`);
  const out = new Map(), outIdeal = new Map();
  for (const lp of loops) lp.towers.forEach((t, i) => { out.set(t.index, LOOP_FLOW * p * (1 - p) ** i); outIdeal.set(t.index, LOOP_FLOW * p); });
  const load = new Map(), loadIdeal = new Map();
  for (const t of towers) {
    let b = (fedBy.get(t.index) ?? []).find((x) => x.inputFromSlot === 0);
    const seen = new Set();
    let home = false;
    let stacked = false; // 过了集装机、分流器以后带上的货物不再是单层，后面的不按单层 1800 算（用户原图两条收集带各过一台集装机再并成一条）
    while (b && !seen.has(b.index)) {
      if (b.itemId === ST) { home = true; break; }
      seen.add(b.index);
      if (!isBelt(b)) {
        if (b.itemId !== PILER && b.itemId !== SPLIT) break;
        stacked = true;
        b = (fedBy.get(b.index) ?? [])[0] ?? null;
        continue;
      }
      if (!stacked) {
        load.set(b.index, (load.get(b.index) ?? 0) + (out.get(t.index) ?? 0));
        loadIdeal.set(b.index, (loadIdeal.get(b.index) ?? 0) + (outIdeal.get(t.index) ?? 0));
      }
      b = b.outputObjIdx >= 0 ? B[b.outputObjIdx] : null;
    }
    if (!home) errors.push(`塔 ${t.index} 的重氢流不回物流站`);
  }
  const maxBelt = load.size ? Math.max(...load.values()) : 0;
  const maxBeltIdeal = loadIdeal.size ? Math.max(...loadIdeal.values()) : 0;
  if (maxBelt > BELT_CAP + 1e-6) errors.push(`收集带最重的一节 ${Math.round(maxBelt)}/分，超过一条极速带单层 ${BELT_CAP}/分`);
  return {
    loops: loops.map((lp) => ({ n: lp.towers.length, pilers: lp.pilers, merges: lp.merges, d: lp.towers.reduce((s, t) => s + out.get(t.index), 0), dIdeal: lp.towers.length * LOOP_FLOW * p })),
    total: [...out.values()].reduce((a, b) => a + b, 0),
    totalIdeal: [...outIdeal.values()].reduce((a, b) => a + b, 0),
    maxBelt,
    maxBeltIdeal,
    errors,
  };
}
