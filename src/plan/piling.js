// 自动集装机的叠层模型（带上集装用，plan/addons.js 的 stackPilers）。
//
// 规则（游戏 0.10.35 的 PilerComponent.InternalUpdate，用户 2026/10/30 确认「只打包一层」，docs/game-rules.md 第 36 条）：
// 一台集装机只把相邻两个货物合成一个，合起来超过 4 层就出一个 4 层、余下的留着和下一个合；第二个货物要在第一个之后
// 窗口之内到（满带首尾相接才赶得上，中间空一个格位就赶不上），赶不上的原样过去（落单）。满 4 层的货物和手里留着的合不了，
// 原样过去、手里那个接着等下一个。所以单个物品进 → 2 层出，再往下补单个物品、再过一台才到 3 层、4 层。
//
// 带上的货物记成 c[1..4]：每分钟各有几个 1~4 层的货物（c[0] 不用）。格位 = 货物数，物品 = 层数合计。
// 过一台集装机按「每个满带格位以 d = 格位 ÷ 单条带运力 的概率有货、各个货物的层数随机排」算（调研笔记 t5.mjs C 组的模型）：
// 手里留着几层（0~3）是一条马尔可夫链，下一个格位空着（概率 1 − d）就落单。单个物品进时出的货物 ÷ 进的货物 F = 1 / (1 + d)，
// 格位 1700/1800 处 0.514、满带 0.5。拿主会话移植的带子、集装机（out/piler-research/sim.mjs）加上分拣器的挤压插入
// （CargoPath.TryInsertItem）模拟过（2026/10/30，14 台工厂沿带放料、产速各不相同，24 个种子）：1700/分 处 F = 0.508、1800/分 0.502，
// 这个模型略保守；串几台（每台放在格位到 1700 处、中间补单个）时第 k 台之后一条带最多运的，模型比模拟少 0.4%~3.4%（k = 1~7）。
// 推断，没进游戏验。

/** 一条带每分钟占的格位过了单条带运力的这么多（极速带 1700 / 1800）就在下游放一台集装机（plan/addons.js 的 stackPilers） */
export const STACK_AT = 17 / 18;

/** 带上的格位（每分钟的货物数）和物品数 */
export const slotsOf = (c) => c[1] + c[2] + c[3] + c[4];
export const itemsOf = (c) => c[1] + 2 * c[2] + 3 * c[3] + 4 * c[4];

/** 解 4 元线性方程组 A x = b（部分选主元消去，A 按行） */
function solve4(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 4; i++) {
    let p = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (p !== i) [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < 4; r++) {
      if (r === i || !M[r][i]) continue;
      const f = M[r][i] / M[i][i];
      for (let k = i; k <= 4; k++) M[r][k] -= f * M[i][k];
    }
  }
  return M.map((r, i) => r[4] / r[i]);
}

/**
 * 过一台集装机之后带上的货物（返回新的 c，不改 c）。cap：单条带的运力（每分钟格位，极速带 1800）。
 * fresh：上一台集装机之后新放上来的单个物品（每分钟；从带头起算时不限）。一台最多少掉这么多个货物：上一台出的货物之间隔着空格位，
 * 要有新放的单个填进去才挨得上（两台紧挨着、中间没放新的，第二台没用；调研笔记 §0.4），按 fresh 把合并的效果按比例收小
 */
export function pileOnce(c, cap, fresh = Infinity) {
  const S = slotsOf(c);
  const P = c[1] + c[2] + c[3]; // 不满 4 层的货物
  if (!(P > 1e-9)) return c.slice();
  const g = Math.min(1, Math.max(0, 1 - S / cap)); // 下一个格位空着的概率：手里那个落单
  const q = [0, c[1] / P, c[2] / P, c[3] / P];
  // T[a][a2]：手里留着 a 层（0 是空的）时来一个不满 4 层的货物 b，之后留着 a2 层。满 4 层的原样过去，不进这条链
  const T = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  for (let b = 1; b <= 3; b++) {
    T[0][b] += q[b];
    for (let a = 1; a <= 3; a++) {
      T[a][b] += g * q[b]; // 落单：手里那个原样出去，新来的留着
      T[a][a + b <= 4 ? 0 : a + b - 4] += (1 - g) * q[b]; // 合上：不超过 4 层出一个，超过出一个 4 层、余下的留着
    }
  }
  // 稳态分布 π：π T = π，各项和为 1（第一个方程换成归一化）
  const A = [[1, 1, 1, 1], ...[1, 2, 3].map((j) => [0, 1, 2, 3].map((a) => T[a][j] - (a === j ? 1 : 0)))];
  const pi = solve4(A, [1, 0, 0, 0]);
  // 每来一个不满 4 层的货物，手里有东西时出一个：落单出 a 层，合上出 min(4, a + b) 层
  const o = [0, 0, 0, 0, 0];
  for (let a = 1; a <= 3; a++) {
    o[a] += pi[a] * g;
    for (let b = 1; b <= 3; b++) o[Math.min(4, a + b)] += pi[a] * (1 - g) * q[b];
  }
  const out = [0, o[1] * P, o[2] * P, o[3] * P, c[4] + o[4] * P];
  const drop = S - slotsOf(out);
  if (!(drop > fresh)) return out;
  const t = Math.max(0, fresh) / drop;
  return c.map((v, i) => v + (out[i] - v) * t);
}

/**
 * 一条带放 k 台集装机最多运多少（每分钟物品；cap 是单条带运力）：按最坏的料全先放后取，每台放在格位到 STACK_AT 的地方，
 * 每台之后下游补的是单个物品，最后一台之后补到满带。极速带 k = 1~7：2626、3451、4119、4641、5071、5419、5700（以前按一台叠满 4 层，7200）
 */
const REACH = new Map();
export function pileReach(cap, k) {
  const key = `${cap}|${k}`;
  if (REACH.has(key)) return REACH.get(key);
  let c = [0, 0, 0, 0, 0];
  for (let i = 0; i < k; i++) {
    const add = Math.max(0, cap * STACK_AT - slotsOf(c));
    c[1] += add;
    c = pileOnce(c, cap, add);
  }
  const v = itemsOf(c) + cap - slotsOf(c);
  REACH.set(key, v);
  return v;
}

/**
 * 开自动集装机时产物带一条按多少运力排（layout/belts.js 的 pileCap、plan/typeset.js 的 blockCaps、网页 worker 的 bottleneck）。
 * slot：单条带每分钟的格位（BELT_SPEED × 60）。pileModel（route 选项）：不写照旧按叠满 4 层算 slot × 4；
 * 正整数 k 按一条带最多放 k 台集装机够得着的（pileReach）
 */
export function pileCapOf(slot, pileModel = null) {
  return pileModel > 0 ? pileReach(slot, Math.floor(pileModel)) : slot * 4;
}

/**
 * 取料 e 个（每分钟）：照旧保守，只减物品、格位不多于物品数（取料的分拣器拿的是整个货物，这里当它不减格位）。
 * 减哪些：先把 2 层的减成单个、再减 3 层的、最后减 4 层的（4 层的过集装机不再变少，留着它对后面的集装机更保守）；
 * 都是单个了才减格位。改写并返回 c
 */
export function takeItems(c, e) {
  for (let k = 2; k <= 4 && e > 0; k++) {
    const m = Math.min(c[k], e / (k - 1));
    c[k] -= m;
    c[1] += m;
    e -= m * (k - 1);
  }
  if (e > 0) c[1] = Math.max(0, c[1] - e);
  return c;
}
