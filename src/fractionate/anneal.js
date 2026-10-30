// 分馏阵列（重氢）第二阶段：从原理排 + 退火（用户 2026/10/30：「让退火算利用率高的，不过我更倾向，原来那样物流站在中上，方形左右对称的」）。
// 原理和第一阶段的估算在 docs/frac-anneal-design.md。现在网页默认还是 array.js 照用户原图裁剪，这里是新选项。
//
// 一张图 = 最上面正中一座星际物流站 + 下面并排的 K 组「对列」（K = 1、2、3，左右对称）：
//   一组对列：东列（朝西，氢往南）是进口列，西列（朝东，氢往北）是出口列，两列塔心隔 6、中间一条收集带往北（往站那头）流；
//   氢在组里绕一圈：西列最上面那座出来过 1 台集装机压回 4 层，在顶上那行往东回到东列，新氢在 (东列 − 2) 那格从北边侧面并进来；
//   收集带在回程那行抬半层跨过回程带，接着往北去站。组的上方是「设备块」：新氢那条先过喷涂机、再过集装机（隔 3 格），
//   重氢那条（照用户原图也喷）一台喷涂机，两台喷涂机背后同一行第 1 层走增产剂带。塔位可以留「空位」（直带）给电力感应塔。
//   中间那组（K 为奇数）接站南边三个口，左右两组接站西边、东边三个口（每组新氢、重氢、增产剂各一个口），两边是同一组平移过去（游戏里塔的
//   1、2 号口只认 1 进 2 出，左右镜像要换口，没做）。
// 几何规矩（东西向按最窄纬度 0.8516 算，任何纬度都能贴）：塔沿南北串（塔距 4）、东西 ≥ 5；不相连的带离塔心东西 ≥ 3 或南北 ≥ 2；
//   电塔离塔心两个方向之一 ≥ 3；集装机盒子里只许它自己那条直带（游戏规则第 43 条）；站的十字碰撞体（设备之间每一步按建造盒、最窄纬度查）。最后整张过 checkArray（赤道 + 最窄纬度）
//   和 flow.js 的稳态运力核对。
// 退火（按步数、种子定了结果一字不差）：状态 = K、每组几行 / 几个空位、组的上下位置、组间距；组到站的线用 A*（格 × 高度 0 / 0.5 / 1），
//   电塔按覆盖贪心。代价 = 面积 ×（长宽比偏离方形的罚）+ 排不出的重罚。
import { fromStr, toStr } from '../codec/parser.js';
import { TEMPLATE } from './template.js';
import { collisions } from './compact.js';
import { checkArray, SPRAY } from './array.js';
import { flowCheck, loopYield, maxTowersPerBelt } from './flow.js';
import { powerReach, CELL_M } from '../plan/power.js';

const ST = 2104, FRAC = 2314, PILER = 2040, COATER = 2313, TESLA = 2201, BELT = 2003;
const NAME = { [ST]: '物流站', [FRAC]: '分馏塔', [PILER]: '集装机', [COATER]: '喷涂机', [TESLA]: '电力感应塔' };
const H = 1120, D = 1121;
const EWMIN = 0.8516; // 高于 15 行的蓝图能贴到的最窄东西向格宽（gamedata.js 的 narrowestEW），压紧、电塔都按这个
let TPL = null;
const tpl = () => (TPL ??= fromStr(TEMPLATE));
const proto = (id) => tpl().buildings.find((b) => b.itemId === id);
/** 站口（站朝向 0）：口号 → 相对站心的方向（同 src/plan/stations.js 的 STATION_PORTS） */
const PORTS = { 0: [1, 2], 1: [0, 2], 2: [-1, 2], 3: [-2, 1], 4: [-2, 0], 5: [-2, -1], 6: [-1, -2], 7: [0, -2], 8: [1, -2], 9: [2, -1], 10: [2, 0], 11: [2, 1] };

/** 可复现的伪随机数（同 plan/place.js 的 rng） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 蓝图积木
class Bp {
  constructor() { this.B = []; }
  add(id, x, y, z = 0, yaw = 0) {
    const b = structuredClone(proto(id));
    b.index = this.B.length;
    b.localOffset = [{ x, y, z }, { x, y, z }];
    b.yaw = [yaw, yaw];
    b.outputObjIdx = -1;
    b.inputObjIdx = -1;
    if (id === BELT) { b.outputToSlot = 1; b.inputFromSlot = 0; b.inputToSlot = 1; b.outputFromSlot = 0; b.parameters = null; }
    this.B.push(b);
    return b;
  }
  /** 一串带子：nodes [[x,y,z]...]；from = [建筑, 口]；to = [建筑, 口] 或 { belt } 从侧面并进另一节带子 */
  chain(nodes, { from = null, to = null } = {}) {
    const bs = nodes.map(([x, y, z]) => this.add(BELT, x, y, z));
    for (let i = 0; i < bs.length; i++) {
      const p = nodes[i], q = nodes[i + 1] ?? null, o = nodes[i - 1] ?? null;
      let [dx, dy] = q ? [q[0] - p[0], q[1] - p[1]] : o ? [p[0] - o[0], p[1] - o[1]] : [0, 1];
      if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3 && o) [dx, dy] = [p[0] - o[0], p[1] - o[1]];
      const yaw = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 90 : 270) : dy >= 0 ? 0 : 180;
      bs[i].yaw = [yaw, yaw];
      if (i + 1 < bs.length) { bs[i].outputObjIdx = bs[i + 1].index; bs[i].outputToSlot = 1; }
    }
    if (from && bs.length) { bs[0].inputObjIdx = from[0].index; bs[0].inputFromSlot = from[1]; }
    const last = bs.at(-1);
    if (last && to?.belt) this.merge(last, to.belt);
    else if (last && to) { last.outputObjIdx = to[0].index; last.outputToSlot = to[1]; }
    return bs;
  }
  /** 侧面并带：从接收那节的朝向看，左边进来记 2、右边进来记 3（照用户原图） */
  merge(last, r) {
    const ry = r.yaw[0], p = last.localOffset[0], c = r.localOffset[0];
    const fx = Math.round(Math.sin((ry * Math.PI) / 180)), fy = Math.round(Math.cos((ry * Math.PI) / 180));
    const cross = fx * (p.y - c.y) - fy * (p.x - c.x);
    last.outputObjIdx = r.index;
    last.outputToSlot = cross > 0 ? 2 : 3;
  }
  at(x, y, z) {
    return this.B.find((b) => b.itemId === BELT && Math.abs(b.localOffset[0].x - x) < 0.01 && Math.abs(b.localOffset[0].y - y) < 0.01 && Math.abs(b.localOffset[0].z - z) < 0.01);
  }
}

/**
 * 一组对列，回程在北（顶上）。dx：东列（进口列，朝西）的 x；r0：回程带那一行。东列塔位 i（0 在最北）在 (dx, r0 − 2 − 4i)，
 * 西列（出口列，朝东）在 (dx − 6, …)，从第 nL − nR 个塔位起有塔（最北那几个塔位让给集装机）。holes {L, R}：塔位换成直带（L 东列、R 西列，
 * 编号同上）。返回并带点、重氢最后一节等接口（全局坐标），以及这组用到的格（给 A* 挡路）
 */
function pair(bp, dx, r0, nL, nR, holes, letter, tags) {
  // 照第一阶段原型（out/frac-anneal/proto.mjs 的 pair）：组内坐标方位 A（回程在南）写好，整组转 180°：组内 (x, y) → (dx − x, r0 − 2 − y)
  const dy = r0 - 2;
  const T = (x, y, z = 0) => [dx - x, dy - y, z];
  const yawT = (a) => (a + 180) % 360;
  const ch = (nodes, opt) => bp.chain(nodes.map((n) => T(...n)), opt);
  const r0l = nL - nR;
  const L = [], R = [];
  const put = (x, y, yaw) => { const [X, Y] = T(x, y); const t = bp.add(FRAC, X, Y, 0, yawT(yaw)); tags.set(t.index, letter); return t; };
  for (let i = 0; i < nL; i++) L[i] = holes.L.has(i) ? null : put(0, 4 * i, 90);
  for (let i = r0l; i < nL; i++) R[i] = holes.R.has(i) ? null : put(6, 4 * i, 270);
  const yt = 4 * (nL - 1);
  const colNodes = (x, i, dir) => {
    const y = 4 * i;
    return dir > 0 ? [[x, y + 1.113, 0.004], [x, y + 2, 0.012], [x, y + 2.887, 0.004]] : [[x, y - 1.115, 0.004], [x - 0.001, y - 2, 0.012], [x, y - 2.885, 0.004]];
  };
  const linkCol = (towers, x, idx, dir, head, tail) => {
    let pending = head.nodes, from = head.from;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], t = towers[i];
      if (t) { ch(pending, { from, to: [t, 1] }); from = [t, 2]; pending = []; }
      else pending = [...pending, [x, 4 * i, 0]];
      if (k + 1 < idx.length) pending = [...pending, ...colNodes(x, i, dir)];
    }
    const rest = [...pending, ...tail.nodes];
    if (rest.length) ch(rest, { from, to: tail.to });
  };
  const turn = [[0, yt + 1.113, 0.004], [0, yt + 1.988, 0.012], [1, yt + 2, 0], [2, yt + 2, 0], [3, yt + 2, 0], [4, yt + 2, 0], [5, yt + 2, 0], [5.999, yt + 1.99, 0.012], [6, yt + 1.115, 0.004]];
  const yb = 4 * r0l, py = yb - 4;
  const [PX, PY] = T(6, py);
  const pil = bp.add(PILER, PX, PY, 0, yawT(180));
  tags.set(pil.index, letter);
  const ret = [[6, py - 0.199, 0], [6, py - 1.075, 0.003]];
  for (let y = Math.round(py - 2); y >= -2; y--) ret.push([6, y, 0]);
  ret.push([5, -2, 0], [4, -2, 0], [3, -2, 0], [2, -2, 0], [1, -2, 0]);
  linkCol(L, 0, [...Array(nL).keys()], +1, { nodes: [...ret, [0, -1.988, 0.012], [0, -1.113, 0.004]], from: [pil, 0] }, { nodes: [], to: null });
  const tail = [[6, yb - 1.115, 0.004], [5.999, yb - 1.99, 0.012], [6, yb - 2.925, 0.003], [6, py + 0.199, 0]];
  linkCol(R, 6, [...Array(nL - r0l).keys()].map((k) => nL - 1 - k), -1, { nodes: turn, from: [L[nL - 1], 2] }, { nodes: tail, to: [pil, 1] });
  const rTop = R[nL - 1];
  const col = [];
  if (rTop) col.push([4.887, yt, 0.004], [4.013, yt, 0.012]);
  for (let y = yt; y >= -1; y--) col.push([3, y, 0]);
  col.push([3, -2, 0.5]);
  const dBelts = ch(col, { from: rTop ? [rTop, 0] : null });
  const colAt = (y) => { const [X, Y] = T(3, y); return bp.at(X, Y, 0); };
  for (let i = 0; i < nL; i++) if (L[i]) ch([[1.113, 4 * i, 0.004], [1.987, 4 * i, 0.012]], { from: [L[i], 0], to: { belt: colAt(4 * i) } });
  for (let i = r0l; i < nL - (rTop ? 1 : 0); i++) if (R[i]) ch([[4.887, 4 * i, 0.004], [4.013, 4 * i, 0.012]], { from: [R[i], 0], to: { belt: colAt(4 * i) } });
  const [mx, my] = T(2, -2);
  return {
    merge: bp.at(mx, my, 0), dLast: dBelts.at(-1), pil,
    xf: dx - 2, xd: dx - 3, r0,
    x0: dx - 7, x1: dx + 1, y0: r0 - 4 * nL, y1: r0,
    towers: [...L, ...R].filter(Boolean),
  };
}

// ---------------------------------------------------------------- 网格和 A*（格 × 高度 0、0.5、1）
const ZS = [0, 0.5, 1];
class Grid {
  constructor(x0, y0, x1, y1) {
    Object.assign(this, { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    this.block = new Uint8Array(this.w * this.h * 3); // 1：不许带子走
    this.belt = new Uint8Array(this.w * this.h * 3); // 1：这一格这一高度已经有带子
    this.any = new Uint8Array(this.w * this.h); // 这格有带子（任何高度）
    this.solid = new Uint8Array(this.w * this.h); // 这格有建筑占地
  }
  in(x, y) { return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1; }
  k(x, y) { return (y - this.y0) * this.w + (x - this.x0); }
  blockAt(x, y, zs = [0, 1, 2]) { if (this.in(x, y)) for (const z of zs) this.block[this.k(x, y) * 3 + z] = 1; }
  markBelt(x, y, z) {
    if (!this.in(x, y)) return;
    const zi = Math.max(0, Math.min(2, Math.round(z * 2)));
    this.belt[this.k(x, y) * 3 + zi] = 1;
    this.any[this.k(x, y)] = 1;
  }
  free(x, y, zi) { return this.in(x, y) && !this.block[this.k(x, y) * 3 + zi] && !this.belt[this.k(x, y) * 3 + zi]; }
}
const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // 北、东、南、西

/**
 * A*：从 start {x, y, zi, dir（离开 start 的方向，null 随便）} 走到 goal {x, y, zi, dirIn（到 goal 那一步的方向，null 随便）}。
 * 每步走到东西南北相邻一格，高度变 0 或 ±0.5（一格坡半层）；不许掉头；zs 允许的高度。代价：步数 + 转弯 0.4 + 变高度 1.5。
 * 返回格子序列 [[x, y, zi]...]（含 start、goal），走不通给 null
 */
function astar(G, start, goal, { zs = [0, 1], maxNodes = 60000 } = {}) {
  const key = (x, y, zi, d) => ((((y - G.y0) * G.w + (x - G.x0)) * 3 + zi) << 2) | d;
  const hfun = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const open = []; // 二叉堆 [f, g, x, y, zi, d, parentKey]
  const push = (n) => { open.push(n); let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p][0] <= open[i][0]) break; [open[p], open[i]] = [open[i], open[p]]; i = p; } };
  const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m; } } return top; };
  const best = new Map(), parent = new Map();
  const d0s = start.dir == null ? [0, 1, 2, 3] : [start.dir];
  for (const d of d0s) { const k = key(start.x, start.y, start.zi, d); best.set(k, 0); parent.set(k, -1); push([hfun(start.x, start.y), 0, start.x, start.y, start.zi, d, -1]); }
  let n = 0;
  while (open.length && n++ < maxNodes) {
    const [, g, x, y, zi, d] = pop();
    const ck = key(x, y, zi, d);
    if (g > (best.get(ck) ?? Infinity)) continue;
    if (x === goal.x && y === goal.y && zi === goal.zi && (goal.dirIn == null || goal.dirIn === d) && !(x === start.x && y === start.y && n === 1)) {
      const path = [];
      let k = ck;
      while (k !== -1) {
        const d2 = k & 3, rest = k >> 2, z2 = rest % 3, cell = (rest - z2) / 3;
        path.push([G.x0 + (cell % G.w), G.y0 + Math.floor(cell / G.w), z2]);
        k = parent.get(k);
        void d2;
      }
      return path.reverse();
    }
    // 第一步方向：start.dir；之后任意（不掉头）
    for (let nd = 0; nd < 4; nd++) {
      if (g === 0 && start.dir != null && nd !== start.dir) continue;
      if (g > 0 && (nd + 2) % 4 === d) continue;
      const [ddx, ddy] = DIRS[nd];
      const nx = x + ddx, ny = y + ddy;
      for (const nz of [zi - 1, zi, zi + 1]) {
        if (!zs.includes(nz)) continue;
        if (!G.free(nx, ny, nz)) continue;
        const cost = g + 1 + (g > 0 && nd !== d ? 0.4 : 0) + (nz !== zi ? 1.5 : 0);
        const nk = key(nx, ny, nz, nd);
        if (cost >= (best.get(nk) ?? Infinity)) continue;
        best.set(nk, cost);
        parent.set(nk, ck);
        push([cost + hfun(nx, ny), cost, nx, ny, nz, nd, ck]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 一张图：状态 → 建筑
/**
 * 按状态 s 排一张。s = { K, groups: [{ nL, nR, holes: {L:[], R:[]}, r }]（K 奇数时第 0 个是中间那组；r = 回程带离站心往下几行）, g（组间多空几列） }。
 * opt = { spray, sprayD, pilerFresh }。返回 { bp, tags, ok, fail, area, W, H, util, ... }（ok 假时 fail 写原因）
 */
export function buildLayout(s, opt) {
  const { spray = 0, sprayD = spray > 0, pilerFresh = true } = opt;
  const bp = new Bp();
  const tags = new Map();
  const cx = 0, cy = 0; // 站心
  const groups = [];
  const center = s.K % 2 === 1 ? s.groups[0] : null;
  const side = s.K >= 2 ? s.groups[s.K % 2 === 1 ? 1 : 0] : null;
  const g = s.g ?? 0;
  const holesOf = (h) => ({ L: new Set(h?.L ?? []), R: new Set(h?.R ?? []) });
  // 设备块：新氢那条从上往下 入口 → 喷涂机（r0+5，背后 r0+6）→ 集装机（r0+2）→ 并带点 r0；重氢那条 r0（半层坡）→ … → 喷涂机（r0+5）→ 出口
  const coaterRow = 5;
  const fEntry = spray ? 7 : pilerFresh ? 4 : 1; // 新氢那条从 A* 接进设备块的那一格（离回程带几行）
  const dExit = spray && sprayD ? 7 : 2;
  const blockTop = Math.max(fEntry, dExit);
  // 组的位置
  if (center) groups.push({ ...center, dx: cx + 3, side: 'S', letter: 'A' });
  if (side) {
    const dl = center ? cx - 8 - g : cx - 3 - g;
    const dr = center ? cx + 14 + g : cx + 9 + g;
    groups.push({ ...side, dx: dl, side: 'W', letter: center ? 'B' : 'A' }, { ...side, dx: dr, side: 'E', letter: center ? 'C' : 'B' });
  }
  const P = groups.map((gr) => pair(bp, gr.dx, cy - gr.r, gr.nL, gr.nL - 1, holesOf(gr.holes), gr.letter, tags));
  // 站
  const st = bp.add(ST, cx, cy, 0, 0);
  tags.set(st.index, 'S');
  const params = structuredClone(proto(ST).parameters);
  st.parameters = params;
  params.storage = [
    { itemId: D, localRole: 1, remoteRole: 1, max: 14000, lockAmount: 0 },
    { itemId: H, localRole: 2, remoteRole: 2, max: 14000, lockAmount: 0 },
    spray ? { itemId: SPRAY[spray].item, localRole: 2, remoteRole: 2, max: 8600, lockAmount: 0 } : { itemId: 0, localRole: 0, remoteRole: 0, max: 0, lockAmount: 0 },
    { itemId: 0, localRole: 0, remoteRole: 0, max: 0, lockAmount: 0 },
    { itemId: 1210, localRole: 2, remoteRole: 0, max: 100, lockAmount: 0 },
  ];
  params.slots = params.slots.map(() => ({ dir: 0, storageIdx: 0 }));
  const portOf = (slot) => {
    const [dx, dy] = PORTS[slot];
    const nx = Math.abs(dx) === 2 ? Math.sign(dx) : 0, ny = Math.abs(dy) === 2 ? Math.sign(dy) : 0;
    const bx = cx + (nx ? 0 : dx), by = cy + (ny ? 0 : dy);
    return { nodes: (z2) => [[bx + nx * 2.146, by + ny * 2.146, 0.009], [bx + nx * 3.021, by + ny * 3.021, z2]], cell: [bx + nx * 4, by + ny * 4], dirIn: nx > 0 ? 3 : nx < 0 ? 1 : ny > 0 ? 2 : 0, dirOut: nx > 0 ? 1 : nx < 0 ? 3 : ny > 0 ? 0 : 2 };
  };
  // 每组三个口：新氢、重氢、增产剂
  const SLOTS = { S: { fresh: 8, d: 7, p: 6 }, W: { fresh: 5, d: 4, p: 3 }, E: { fresh: 10, d: 9, p: 11 } };
  // 设备：新氢集装机、两台喷涂机
  const dev = [];
  for (const [i, gr] of groups.entries()) {
    const p = P[i];
    if (pilerFresh) {
      const pl = bp.add(PILER, p.xf, p.r0 + 2, 0, 180);
      tags.set(pl.index, gr.letter);
      dev.push({ kind: 'piler', b: pl, x: p.xf, y: p.r0 + 2 });
      p.pilF = pl;
    }
    if (spray) {
      const c1 = bp.add(COATER, p.xf, p.r0 + coaterRow, 0.02, 180);
      dev.push({ kind: 'coater', b: c1, x: p.xf, y: p.r0 + coaterRow });
      if (sprayD) { const c2 = bp.add(COATER, p.xd, p.r0 + coaterRow, 0.02, 180); dev.push({ kind: 'coater', b: c2, x: p.xd, y: p.r0 + coaterRow }); }
    }
  }
  // 包围：所有组、站；线只许在这个范围里走（左右对称），站最上面那行就是图的顶
  const X0 = Math.min(...P.map((p) => p.x0), cx - 3), X1 = Math.max(...P.map((p) => p.x1), cx + 3);
  const Y0 = Math.min(...P.map((p) => p.y0)), Y1 = cy + 3;
  if (Math.max(...P.map((p) => p.r0 + blockTop)) > Y1) return { ok: false, fail: '设备块高过站顶' };
  const G = new Grid(X0, Y0, X1, Y1);
  // 挡路：塔（东西 ≤ 2、南北 ≤ 1 不许不相连的带子）、站的十字、集装机（自己那格和顺着带子前后一格）、喷涂机
  for (const b of bp.B) {
    const o = b.localOffset[0], x = Math.round(o.x), y = Math.round(o.y);
    if (b.itemId === FRAC) { for (let ddx = -2; ddx <= 2; ddx++) for (let ddy = -1; ddy <= 1; ddy++) G.blockAt(x + ddx, y + ddy); for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = -1; ddy <= 1; ddy++) if (G.in(x + ddx, y + ddy)) G.solid[G.k(x + ddx, y + ddy)] = 1; }
    else if (b.itemId === ST) { for (let ddx = -3; ddx <= 3; ddx++) for (let ddy = -3; ddy <= 3; ddy++) { if ((Math.abs(ddx) <= 3 && Math.abs(ddy) <= 2) || (Math.abs(ddx) <= 2 && Math.abs(ddy) <= 3)) G.blockAt(x + ddx, y + ddy); if (G.in(x + ddx, y + ddy)) G.solid[G.k(x + ddx, y + ddy)] = 1; } }
    else if (b.itemId === PILER) { const q = Math.round(b.yaw[0] / 90) % 2; for (let k = -1; k <= 1; k++) G.blockAt(x + (q ? k : 0), y + (q ? 0 : k)); }
    else if (b.itemId === COATER) { G.blockAt(x, y); G.blockAt(x, y - 1); G.blockAt(x, y + 1, [0, 1]); }
    else if (b.itemId === BELT) G.markBelt(x, y, o.z);
  }
  // 设备块里的格子（还没建带子）也先占上：新氢那列 r0+1 … 入口，重氢那列 r0+1 … 出口
  for (const p of P) {
    for (let k = 1; k <= fEntry; k++) G.markBelt(p.xf, p.r0 + k, 0);
    for (let k = 1; k <= dExit; k++) G.markBelt(p.xd, p.r0 + k, 0);
  }
  // 线：先中间那组，再左、右；每组 新氢、重氢、增产剂。各口外面第一格先占住，轮到那条线才放开
  const lines = [];
  const take = (path) => { for (const [x, y, zi] of path) G.markBelt(x, y, ZS[zi]); };
  const portCells = [];
  for (const gr of groups) for (const k of ['fresh', 'd', ...(spray ? ['p'] : [])]) portCells.push(portOf(SLOTS[gr.side][k]).cell);
  for (const [x, y] of portCells) G.blockAt(x, y);
  const release = (cell, zs = [0, 1, 2]) => { for (const z of zs) G.block[G.k(cell[0], cell[1]) * 3 + z] = 0; };
  for (const [i, gr] of groups.entries()) {
    const p = P[i];
    const sl = SLOTS[gr.side];
    // 新氢：站口 → 设备块入口（从入口往南进设备块）；出站口那一步照口的朝向往外
    const fp = portOf(sl.fresh);
    release(fp.cell);
    // 入口那格算终点：先放开（设备块的格子之前占上了）
    G.belt[G.k(p.xf, p.r0 + fEntry) * 3] = 0;
    const fpath = astar(G, { x: fp.cell[0], y: fp.cell[1], zi: 0, dir: fp.dirOut }, { x: p.xf, y: p.r0 + fEntry, zi: 0, dirIn: null });
    if (!fpath || fpath.length < 2) return { ok: false, fail: `第 ${i + 1} 组新氢线接不上站 ${sl.fresh} 号口` };
    // 入口那格下一步往南：到入口的最后一步不能是从南边上来的（那样要掉头）
    { const [ax, ay] = fpath.at(-2); if (ay === p.r0 + fEntry - 1 && ax === p.xf) return { ok: false, fail: `第 ${i + 1} 组新氢线从南边进设备块` }; }
    take(fpath);
    // 重氢：设备块出口 → 站口（进站那一步朝站）
    const dp = portOf(sl.d);
    release(dp.cell);
    const dpath = astar(G, { x: p.xd, y: p.r0 + dExit, zi: 0, dir: 0 }, { x: dp.cell[0], y: dp.cell[1], zi: 0, dirIn: dp.dirIn });
    if (!dpath) return { ok: false, fail: `第 ${i + 1} 组重氢线接不上站 ${sl.d} 号口` };
    take(dpath.slice(1));
    lines.push({ i, gr, p, fp, fpath, dp, dpath, sl });
  }
  // 增产剂：站口出来抬到 1 层，横穿每组两台喷涂机背后那格（东西向），多留一节
  if (spray) {
    for (const ln of lines) {
      const { p, sl } = ln;
      const pp = portOf(sl.p);
      release(pp.cell);
      const row = p.r0 + coaterRow + 1;
      const xs = sprayD ? [p.xd, p.xf] : [p.xf];
      let bestPath = null;
      for (const fromEast of [true, false]) {
        const seq = fromEast ? [...xs].reverse() : xs; // 经过的顺序
        const pre = fromEast ? seq[0] + 1 : seq[0] - 1;
        const post = fromEast ? seq.at(-1) - 1 : seq.at(-1) + 1;
        if (!G.in(pre, row) || !G.in(post, row)) continue;
        if (![...seq, post].every((x) => G.free(x, row, 2) || (x === post && G.free(x, row, 2)))) continue;
        const path = astar(G, { x: pp.cell[0], y: pp.cell[1], zi: 2, dir: pp.dirOut }, { x: pre, y: row, zi: 2, dirIn: fromEast ? 3 : 1 }, { zs: [2] });
        if (!path) continue;
        const full = [...path, ...seq.map((x) => [x, row, 2]), [post, row, 2]];
        if (!bestPath || full.length < bestPath.length) bestPath = full;
      }
      if (!bestPath) return { ok: false, fail: `第 ${ln.i + 1} 组增产剂带接不上站 ${sl.p} 号口` };
      take(bestPath);
      ln.ppath = bestPath;
      ln.pp = pp;
    }
  }
  // ---- 把线建成带子
  for (const ln of lines) {
    const { p, fp, fpath, dp, dpath, sl } = ln;
    params.slots[sl.fresh] = { dir: 1, storageIdx: 2 };
    params.slots[sl.d] = { dir: 2, storageIdx: 1 };
    // 新氢：站口两节 + A* 那几格 + 设备块（入口下面一格起往南：喷涂机那几格、集装机进出两节、并带点上面那格）
    const fNodes = [...fp.nodes(0.022), ...fpath.map(([x, y, zi]) => [x, y, ZS[zi]])];
    const below = [];
    for (let k = fEntry - 1; k >= 1; k--) {
      if (pilerFresh && k === 2) continue; // 集装机那格拆成两节
      below.push([p.xf, p.r0 + k, 0]);
    }
    if (pilerFresh) {
      const k3 = below.findIndex((n) => n[1] === p.r0 + 1); // 集装机下面那格
      const pre = below.slice(0, k3), post = below.slice(k3);
      const a = bp.chain([...fNodes, ...pre, [p.xf, p.r0 + 2.199, 0]], { from: [st, sl.fresh], to: [p.pilF, 1] });
      void a;
      bp.chain([[p.xf, p.r0 + 1.801, 0], ...post], { from: [p.pilF, 0], to: { belt: p.merge } });
    } else bp.chain([...fNodes, ...below], { from: [st, sl.fresh], to: { belt: p.merge } });
    // 重氢：回程带上面那节（半层坡）之后 r0+1 … 出口 + A* + 站口两节
    const dNodes = [];
    for (let k = 1; k <= dExit; k++) dNodes.push([p.xd, p.r0 + k, 0]);
    for (const [x, y, zi] of dpath.slice(1)) dNodes.push([x, y, ZS[zi]]);
    const dIn = bp.chain([...dNodes, ...dp.nodes(0.022).reverse()], { to: [st, sl.d] });
    p.dLast.outputObjIdx = dIn[0].index;
    p.dLast.outputToSlot = 1;
    if (ln.ppath) {
      params.slots[sl.p] = { dir: 1, storageIdx: 3 };
      const pb = bp.chain([...ln.pp.nodes(0.5), ...ln.ppath.map(([x, y, zi]) => [x, y, ZS[zi]])], { from: [st, sl.p] });
      for (const b of pb) tags.set(b.index, 'P');
    }
  }
  return { ok: true, bp, tags, G, P, groups, st, dev, X0, X1, Y0, Y1 };
}

// ---------------------------------------------------------------- 电力感应塔
/**
 * 覆盖贪心：候选格 = 地面没建筑、这格没有带子、离塔心东西南北都 ≤ 2 以外、站的十字外 0.3 m、集装机 / 喷涂机顺着带子前后一格以外；
 * 两座之间（东西向按最窄格宽）≥ 3.5 m；每次挑新盖到最多的，盖全以后补连通。给 { placed, uncovered }
 */
function placeTeslas(L) {
  const { bp, G } = L;
  const B = bp.B;
  const reach = powerReach('tesla');
  const need = B.filter((b) => [FRAC, PILER, COATER, ST].includes(b.itemId));
  const bad = new Uint8Array(G.w * G.h);
  const mark = (x, y) => { if (G.in(x, y)) bad[G.k(x, y)] = 1; };
  for (const b of B) {
    const o = b.localOffset[0], x = Math.round(o.x), y = Math.round(o.y);
    if (b.itemId === FRAC) for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) mark(x + i, y + j);
    else if (b.itemId === ST) for (let i = -4; i <= 4; i++) for (let j = -3; j <= 3; j++) { if ((Math.abs(i) <= 4 && Math.abs(j) <= 2) || (Math.abs(i) <= 2 && Math.abs(j) <= 3)) mark(x + i, y + j); }
    else if (b.itemId === PILER || b.itemId === COATER) { const q = Math.round(b.yaw[0] / 90) % 2; for (let k = -1; k <= 1; k++) mark(x + (q ? k : 0), y + (q ? 0 : k)); }
  }
  const cand = [];
  for (let y = G.y0; y <= G.y1; y++) for (let x = G.x0; x <= G.x1; x++) {
    const k = G.k(x, y);
    if (bad[k] || G.solid[k] || G.any[k]) continue;
    cand.push({ x, y });
  }
  const r2 = reach.cover * reach.cover;
  const covers = cand.map((c) => need.filter((n) => (n.localOffset[0].x - c.x) ** 2 + (n.localOffset[0].y - c.y) ** 2 <= r2).map((n) => n.index));
  const covered = new Set();
  const placed = [];
  const far = (c) => placed.every((p) => ((p.x - c.x) * EWMIN * CELL_M) ** 2 + ((p.y - c.y) * CELL_M) ** 2 >= 12.25);
  while (covered.size < need.length) {
    let best = -1, bs = 0;
    for (let i = 0; i < cand.length; i++) {
      if (!far(cand[i])) continue;
      let k = 0;
      for (const j of covers[i]) if (!covered.has(j)) k++;
      if (k > bs) { bs = k; best = i; }
    }
    if (best < 0) break;
    placed.push(cand[best]);
    for (const j of covers[best]) covered.add(j);
  }
  const linked = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= reach.link * reach.link;
  for (let guard = 0; guard < 12 && placed.length > 1; guard++) {
    const seen = new Set([0]), stk = [0];
    while (stk.length) { const i = stk.pop(); placed.forEach((p, j) => { if (!seen.has(j) && linked(placed[i], p)) { seen.add(j); stk.push(j); } }); }
    if (seen.size === placed.length) break;
    const A = placed.filter((_, i) => seen.has(i)), Bq = placed.filter((_, i) => !seen.has(i));
    const c = cand.find((c) => far(c) && A.some((p) => linked(p, c)) && Bq.some((p) => linked(p, c)));
    if (!c) break;
    placed.push(c);
  }
  return { placed, uncovered: need.length - covered.size };
}

/** 平移到从 0 开始、出蓝图字符串、量面积和利用率（同网页：地面占的格 ÷ 面积） */
function finish(bp, name) {
  const B = bp.B;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of B) {
    const p = b.localOffset[0], h = b.itemId === ST ? 3 : b.itemId === FRAC ? 1 : 0;
    x0 = Math.min(x0, Math.round(p.x) - h); y0 = Math.min(y0, Math.round(p.y) - h);
    x1 = Math.max(x1, Math.round(p.x) + h); y1 = Math.max(y1, Math.round(p.y) + h);
  }
  for (const b of B) for (const o of b.localOffset) { o.x = +(o.x - x0).toFixed(4); o.y = +(o.y - y0).toFixed(4); }
  const W = x1 - x0 + 1, Hh = y1 - y0 + 1;
  const T0 = tpl();
  const out = { ...structuredClone({ ...T0, buildings: [] }), buildings: B };
  out.dragBoxSize = { x: W, y: Hh };
  out.cursorOffset = { x: Math.floor(W / 2), y: Math.floor(Hh / 2) };
  out.areas = [{ ...T0.areas[0], size: { x: W, y: Hh } }];
  const fr = B.filter((b) => b.itemId === FRAC).length;
  out.header = { ...T0.header, icons: [D, FRAC, 0, 0, 0], time: new Date('2026-10-30T12:00:00Z'), shortDesc: name ?? `重氢分馏 ${fr} 塔`, desc: `${W}×${Hh} 格；分馏塔 ${fr} 座。dsp-handcraft 退火排法生成` };
  const ground = new Set();
  for (const b of B) {
    const o = b.localOffset[0], h = b.itemId === ST ? 3 : b.itemId === FRAC ? 1 : 0;
    if (b.itemId === BELT && o.z > 0.25) continue;
    for (let dx = -h; dx <= h; dx++) for (let dy = -h; dy <= h; dy++) ground.add(`${Math.round(o.x + dx)},${Math.round(o.y + dy)}`);
  }
  return { bp: out, str: toStr(out), W, H: Hh, area: W * Hh, fracs: fr, util: ground.size / (W * Hh), shift: { x0, y0 } };
}

// ---------------------------------------------------------------- 状态、代价、退火
// 搜索状态 s = { K, g, groups: [{ n, extra, mode, r }] }：K 为奇数时 groups[0] 是中间那组，groups 的最后一个是左右那两组（一样）；
// n 这组几座塔；extra 比放得下 n 座的最少行数多几行；mode 挑空位的办法（holesFor）；r 回程带在站心往下几行；g 组间多空几列。
// materialize 把它变成排图用的 { K, g, groups: [{ nL, holes, r }] }（nL 东列几个塔位，西列 nL − 1；holes 换成直带的塔位）
const p0 = (spray) => SPRAY[spray].p;
/** 每组几座（左右两组各算一次） */
const countsOf = (s) => (s.K === 1 ? [s.groups[0].n] : s.K === 2 ? [s.groups[0].n, s.groups[0].n] : [s.groups[0].n, s.groups[1].n, s.groups[1].n]);

/** 一组 nL 行放 n 座塔要的空位：按「两头的电塔各盖两行、空位旁的电塔盖对面三行和自己上下各一行」挑；多出来的塔位也换成直带 */
function holesFor(nL, n, mode = 0) {
  const holes = { L: new Set(), R: new Set() };
  const covL = new Set(mode ? [0, nL - 1] : [0, 1, nL - 1, nL - 2]), covR = new Set(mode ? [1, nL - 1] : [1, 2, nL - 1, nL - 2]);
  const isT = (c, i) => (c === 'L' ? i >= 0 && i < nL : i >= 1 && i < nL) && !holes[c].has(i);
  for (let guard = 0; guard < 40; guard++) {
    let lo = null;
    for (let i = 0; i < nL && !lo; i++) {
      if (isT('L', i) && !covL.has(i)) lo = ['L', i];
      else if (isT('R', i) && !covR.has(i)) lo = ['R', i];
    }
    if (!lo) break;
    const [c, i] = lo;
    const o = c === 'L' ? 'R' : 'L';
    const j = Math.max(1, Math.min(i + 1, nL - 2));
    holes[o].add(j);
    const own = o === 'L' ? covL : covR, opp = o === 'L' ? covR : covL;
    own.add(j - 1); own.add(j + 1);
    opp.add(j - 1); opp.add(j); opp.add(j + 1);
  }
  let extra = 2 * nL - 1 - holes.L.size - holes.R.size - n;
  if (extra < 0) return null;
  for (let i = 1; i < nL && extra > 0; i++) if (!holes.R.has(i)) { holes.R.add(i); extra--; }
  for (let i = 0; i < nL - 1 && extra > 0; i++) if (!holes.L.has(i)) { holes.L.add(i); extra--; }
  if (extra > 0) return null;
  return { L: [...holes.L].sort((a, b) => a - b), R: [...holes.R].sort((a, b) => a - b) };
}
/** 一组放 n 座塔：最少几行 */
function groupFor(n, mode = 0) {
  for (let nL = Math.max(2, Math.ceil((n + 1) / 2)); nL < 60; nL++) {
    const h = holesFor(nL, n, mode);
    if (h) return { nL, holes: h };
  }
  return null;
}
/** K 组、每组几座（左右两组一样；K = 3 时中间那组比两边多 split 座），按稳态够产量、每条收集带不超的最少塔数 */
function towersFor(rate, p, K, split = 0) {
  const cap = maxTowersPerBelt(p);
  const fits = (counts) => counts.every((n) => n >= 1 && n <= cap) && counts.reduce((s, n) => s + loopYield(n, p), 0) >= rate - 1e-6;
  for (let tot = 1; tot <= 3 * cap; tot++) {
    let counts;
    if (K === 1) counts = [tot];
    else if (K === 2) { if (tot % 2) continue; counts = [tot / 2, tot / 2]; }
    else { const sideN = Math.floor((tot - split) / 3); const c = tot - 2 * sideN; counts = [c, sideN, sideN]; }
    if (fits(counts)) return counts;
  }
  return null;
}

/** 代价：面积 ×（1 + 0.8 × 超过目标长宽比多少）+ 电塔盖不全、产量不够、收集带超的重罚 + 每座塔 0.5（面积一样时少放塔） */
function costOf(s, r, ctx) {
  if (!r.ok) return 1e9;
  const asp = Math.max(r.W, r.H) / Math.min(r.W, r.H);
  const counts = countsOf(s);
  const yieldSum = counts.reduce((a, n) => a + loopYield(n, ctx.p), 0);
  const short = Math.max(0, ctx.rate - yieldSum);
  const over = counts.reduce((a, n) => a + Math.max(0, n - ctx.cap), 0);
  return r.area * (1 + 0.8 * Math.max(0, asp - ctx.aspectTarget)) + r.uncovered * 400 + (short > 1e-6 ? 5000 + short * 4 : 0) + over * 5000 + 0.5 * counts.reduce((a, n) => a + n, 0);
}

/** 搜索状态 → 排图用的状态；哪组放不下（空位挑不出）给 null */
function materialize(s) {
  const groups = [];
  for (const g of s.groups) {
    const g0 = groupFor(g.n, g.mode);
    if (!g0) return null;
    const nL = g0.nL + g.extra;
    const holes = holesFor(nL, g.n, g.mode);
    if (!holes) return null;
    groups.push({ nL, holes, r: g.r });
  }
  return { K: s.K, g: s.g, groups };
}

/** 按状态排一张、放电塔、量；排不出的 ok 假 */
function evaluate(s, opt) {
  const m = materialize(s);
  if (!m) return { ok: false, fail: '空位挑不出' };
  const L = buildLayout(m, opt);
  if (!L.ok) return { ok: false, fail: L.fail };
  const tz = placeTeslas(L);
  for (const p of tz.placed) { const t = L.bp.add(TESLA, p.x, p.y, 0, 0); L.tags.set(t.index, 'T'); }
  // 设备之间（塔、站、集装机、喷涂机、电塔）按最窄纬度比建造盒：Grid 只挡带子，挡不住塔离站太近（站心西 4、南 4 那座塔赤道上空 3 cm，
  // 离赤道远就撞），以前要到出图前的 checkArray 才发现、整组退火白跑
  const devs = L.bp.B.filter((b) => b.itemId !== BELT);
  const hit = collisions(devs, EWMIN);
  if (hit.length) return { ok: false, fail: `${NAME[devs[hit[0][0]].itemId]}和${NAME[devs[hit[0][1]].itemId]}相撞（东西向按最窄纬度）` };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of L.bp.B) {
    const p = b.localOffset[0], h = b.itemId === ST ? 3 : b.itemId === FRAC ? 1 : 0;
    x0 = Math.min(x0, Math.round(p.x) - h); y0 = Math.min(y0, Math.round(p.y) - h);
    x1 = Math.max(x1, Math.round(p.x) + h); y1 = Math.max(y1, Math.round(p.y) + h);
  }
  const W = x1 - x0 + 1, Hh = y1 - y0 + 1;
  return { ok: true, L, W, H: Hh, area: W * Hh, uncovered: tz.uncovered, teslas: tz.placed.length };
}

/** 组间最多多空几列：2 列就够在两组之间放电塔（背靠背的塔心隔 7），再宽只是为了凑方形往里填空地，不要 */
const G_MAX = 2;
const keyOf = (s) => JSON.stringify([s.K, s.g, s.groups.map((g) => [g.n, g.extra, g.mode, g.r])]);

/** 初始状态：塔数照 towersFor 分（K = 3 时中间那组比两边多 split 座，可以是负的），每组最少几行；回程带离站心先取能排开的最小值（排不开 anneal 会往下推） */
function initial(ctx, K, split) {
  const counts = towersFor(ctx.rate, ctx.p, K, split);
  if (!counts) return null;
  const uniq = K === 1 ? [counts[0]] : K === 2 ? [counts[0]] : [counts[0], counts[1]];
  const { spray, sprayD, pilerFresh } = ctx.opt;
  const blockTop = Math.max(spray ? 7 : pilerFresh ? 4 : 1, spray && sprayD ? 7 : 2);
  const groups = uniq.map((n) => ({ n, extra: 0, mode: 0, r: 0 }));
  if (K % 2 === 1) groups[0].r = blockTop + 4;
  if (K >= 2) groups.at(-1).r = Math.max(3, blockTop - 3);
  return { K, groups, g: 0 };
}

/**
 * 邻居：回程带上下挪 1、组间距 ±1、多 / 少一行、换挑空位的办法、组之间挪塔（K = 3 时中间那组少 2 座、两边各多 1 座，或者反过来，总数不变）、
 * 某组多 / 少 1 座（够不够产量由代价管）
 */
function neighbor(s, rand) {
  const t = { K: s.K, g: s.g, groups: s.groups.map((g) => ({ ...g })) };
  const gr = t.groups[Math.floor(rand() * t.groups.length)];
  const m = rand();
  if (m < 0.28) gr.r = Math.max(1, gr.r + (rand() < 0.5 ? -1 : 1));
  else if (m < 0.38 && t.K >= 2) t.g = Math.max(0, Math.min(G_MAX, t.g + (rand() < 0.5 ? -1 : 1)));
  else if (m < 0.52) gr.extra = Math.max(0, gr.extra + (rand() < 0.5 ? -1 : 1));
  else if (m < 0.6) gr.mode = 1 - gr.mode;
  else if (m < 0.85 && t.K === 3) {
    const [c, sd] = t.groups;
    if (rand() < 0.5) { if (c.n > 2) { c.n -= 2; sd.n += 1; } } else if (sd.n > 1) { c.n += 2; sd.n -= 1; }
  } else gr.n = Math.max(1, gr.n + (rand() < 0.5 ? -1 : 1));
  return t;
}

/** 一次退火：从 s0 起 steps 步，温度从代价的 4% 降到 0.2%（几何），返回最好的 { s, r, c } */
function anneal(s0, ctx, steps, seed, ev) {
  const rand = rng(seed);
  let s = s0, cur = ev(s), cc = costOf(s, cur, ctx);
  // 排不开先把回程带往下推
  for (let tries = 0; !cur.ok && tries < 16; tries++) {
    s = { ...s, groups: s.groups.map((g) => ({ ...g, r: g.r + 1 })) };
    cur = ev(s);
    cc = costOf(s, cur, ctx);
  }
  let best = { s, r: cur, c: cc };
  if (!cur.ok) return best;
  const T0 = 0.04 * cc, T1 = 0.002 * cc;
  for (let i = 0; i < steps; i++) {
    const T = T0 * (T1 / T0) ** (i / Math.max(1, steps - 1));
    const t = neighbor(s, rand);
    const r = ev(t);
    const c = costOf(t, r, ctx);
    if (c <= cc || rand() < Math.exp(-(c - cc) / T)) { s = t; cur = r; cc = c; }
    if (c < best.c) best = { s: t, r, c };
  }
  return best;
}

/** 一座站最多出多少（K = 3、每组都到收集带上限） */
const maxPerStation = (p) => 3 * loopYield(maxTowersPerBelt(p), p);

/**
 * 退火排一张：K 取 1~3（按塔数），每个 K 从一两种初始塔数分法各退火 restarts 次、每次 steps 步，挑代价最小、checkArray 和运力核对都过的。
 * 一座站带不动（每条收集带的上限 × 3 组）就贴几份，每份按 rate ÷ 份数排。
 * @returns 和 array.js 的 fractionatorArray 一样形状的结果（str、bp、plan、buildings、tags、width、height、fracs、notes、spray、rotated），
 *   另加 util（利用率）、search（各次退火的代价、用时）
 */
export function annealedArray(rate, { spray = 3, sprayD = spray > 0, pilerFresh = true, steps = 400, restarts = 2, seed = 7, aspectTarget = 1.25, title } = {}) {
  const t0 = Date.now();
  const p = p0(spray);
  const copies = Math.max(1, Math.ceil(rate / (maxPerStation(p) * 0.995)));
  const per = rate / copies;
  const ctx = { rate: per, p, cap: maxTowersPerBelt(p), aspectTarget, opt: { spray, sprayD, pilerFresh } };
  const cache = new Map();
  const ev = (st) => { const k = keyOf(st); if (!cache.has(k)) cache.set(k, evaluate(st, ctx.opt)); return cache.get(k); };
  const runs = [];
  for (const K of [1, 2, 3]) {
    for (const split of K === 3 ? [-4, -2, 0, 2] : [0]) {
      const s0 = initial(ctx, K, split);
      if (!s0) continue;
      for (let k = 0; k < restarts; k++) {
        const b = anneal(s0, ctx, steps, seed + K * 101 + split * 7 + k * 1013, ev);
        runs.push({ K, split, k, ...b });
      }
    }
  }
  const log = runs.map((r) => ({ K: r.K, split: r.split, k: r.k, cost: Math.round(r.c), ok: r.r.ok, W: r.r.W, H: r.r.H, fail: r.r.fail }));
  const seen = new Set();
  const cands = runs.filter((r) => r.r.ok && r.c < 1e8).sort((a, b) => a.c - b.c).filter((r) => { const k = keyOf(r.s); if (seen.has(k)) return false; seen.add(k); return true; });
  for (const cand of cands) {
    const r = evaluate(cand.s, ctx.opt); // 重排一份（缓存里的建筑已经放过电塔）
    const fin = finish(r.L.bp, title);
    const chk = checkArray(fin.str);
    const fl = flowCheck(fin.str, p);
    if (!chk.ok || fl.errors.length || r.uncovered || fl.total < per - 1e-6) { log.push({ rejected: true, K: cand.s.K, why: [...chk.errors, ...fl.errors].slice(0, 3), total: Math.round(fl.total) }); continue; }
    const counts = countsOf(cand.s);
    const loops = counts.map((n, i) => ({ key: String.fromCharCode(65 + i), towers: n }));
    const total = fl.total;
    const tags = new Map(r.L.tags);
    // finish 平移以后 tags 的编号不变（只改坐标）
    const notes = [
      `退火排法：物流站在最上面正中，下面 ${cand.s.K} 组对列${cand.s.K > 1 ? '、左右对称' : ''}，每组一个氢循环（${counts.join('、')} 座）。按稳态算出重氢约 ${Math.round(total)}/分${copies > 1 ? `，这张贴 ${copies} 份共约 ${Math.round(total * copies)}/分` : ''}（一座塔最多流过 7200/分、分走 ${+(p * 100).toFixed(2)}%，串在一起的塔流过的氢一座比一座少，推断）。`,
      `新氢那条过一台集装机（站出货不到 4 层时叠到 4 层）${spray ? `、一台喷涂机，${sprayD ? '重氢回站前也喷；' : ''}物流站要供氢和${SPRAY[spray].name}` : '；物流站要供氢'}，收重氢。`,
    ];
    if (copies > 1) notes.unshift(`一座物流站最多带 3 组（每条收集带一条极速带单层 1800/分），这张图粘贴 ${copies} 份。`);
    return {
      str: fin.str, bp: fin.bp, buildings: fin.bp.buildings, tags, width: fin.W, height: fin.H, fracs: fin.fracs, spray, rotated: false, notes, util: fin.util,
      plan: { towers: fin.fracs * copies, copies, per: fin.fracs, loops, perTower: total / fin.fracs, rate: total * copies, limits: null, engine: 'anneal' },
      search: { ms: Date.now() - t0, evaluations: cache.size, runs: log, steps, restarts, state: cand.s, layout: materialize(cand.s) },
    };
  }
  throw new Error(`退火排法排不出 ${rate}/分（${log.slice(0, 6).map((l) => JSON.stringify(l)).join(' ')}）`);
}

/**
 * 不退火、只估：按稳态够数要几座塔（K = 1~3 里塔最少的那种分法）、几份、几台集装机（每组 2 台）和喷涂机（喷时每组 2 台）、一座站。
 * 给网页「生成蓝图」下面那行预告用（和 fractionatorArray 的结果一样有 plan.copies、fracs、buildings，buildings 只有 itemId）
 */
export function annealedEstimate(rate, { spray = 3, sprayD = spray > 0 } = {}) {
  const p = p0(spray);
  const copies = Math.max(1, Math.ceil(rate / (maxPerStation(p) * 0.995)));
  let best = null;
  for (const K of [1, 2, 3]) for (const split of K === 3 ? [-4, -2, 0, 2] : [0]) {
    const c = towersFor(rate / copies, p, K, split);
    if (c && (!best || c.reduce((a, n) => a + n, 0) < best.reduce((a, n) => a + n, 0))) best = c;
  }
  const towers = best ? best.reduce((a, n) => a + n, 0) : 0;
  const groups = best ? best.length : 0;
  const list = (id, n) => Array.from({ length: n }, () => ({ itemId: id }));
  const buildings = [...list(FRAC, towers), ...list(PILER, 2 * groups), ...list(COATER, spray ? (sprayD ? 2 : 1) * groups : 0), ...list(ST, 1)];
  return { fracs: towers, buildings, plan: { copies, towers: towers * copies, engine: 'anneal' } };
}

export const __test = { buildLayout, materialize, evaluate, placeTeslas, finish, holesFor, groupFor, towersFor, initial, astar, Grid, costOf, countsOf, maxPerStation };
