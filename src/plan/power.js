// 供电：布局定下来之后，在空地上放电力感应塔或卫星配电站。这是后处理，不参与摆放搜索。
//
// 要覆盖的不只是工厂：分拣器也耗电，每根分拣器（取它两端的中点）也必须在某个电力设施的范围内。
// 传送带不耗电。
//
// 距离换算：蓝图坐标以格为单位。标准星球（半径 200）赤道上一圈 1000 格，一格约 1.2566 m；
// 纬度越高格子越窄，同样的米数覆盖的格子越多，所以按赤道算是最保守的。
// 覆盖判定：工厂/分拣器的中心点在「以设施中心为圆心、覆盖半径为半径」的圆里就算接通（2026/10/03 用户实测：
// 供电范围测试图 T 组电力感应塔接通 3 台、S 组卫星配电站接通 4 台，按中心距排即 7、7.07、8 格和 19、19.8、21、21.21 格，
// 下一台 8.49 格、22 格没接通）。半径按官方米数在赤道上折成格子（电力感应塔 7.96 格、卫星配电站 20.69 格），
// 比实测略小一点，可能是测试图贴的位置不在赤道、格子窄一些；赤道上是最紧的情况，不再另扣余量。
// 连接距离 2026/10/08 实测（验证合集：一排塔间距 16、17、18、19、20 格，只有 16、17 连上）：官方 22 m ÷ 1.2566 = 17.5 格，不扣余量。
//
// 放在哪：
//   电力感应塔 1×1：任何没有工厂、地面带、分拣器经过、头顶也没有高架带的空格。
//   卫星配电站 3×3：九格全空的位置（2026/10/04 实测：紧挨制造台、熔炉本体也行）；两座之间 3×3 不重叠。
//   卫星配电站不进物流站身外那 1 格碰撞圈（gamedata.js 的 STATION_CLEAR，按 9×9 算）；电力感应塔可以贴着站身（实测 D4）。
//   布局里找不到时，在外沿加一条地，取加得少的一边。
// 选址是集合覆盖：贪心每次挑能新覆盖最多目标的位置，最后倒序删掉多余的；
// 设施之间超出连接距离时，在两群之间补一座中继。
import { STATION_CLEAR, powerCells, powerGap, powerHugs, substationPad, slotPoint } from '../gamedata.js';
import { bankSorters, bankLanes } from './burn.js';

export const CELL_M = 1.2566;
export const POWER = {
  tesla: { name: '电力感应塔', itemId: 2201, model: 44, size: 1, cover: 10, link: 22 },
  substation: { name: '卫星配电站', itemId: 2212, model: 68, size: 3, cover: 26, link: 53 },
};
export const COVER_MARGIN = 0; // 覆盖：已实测，按中心点判，不扣余量
export const LINK_MARGIN = 0; // 连接：实测 17 格通、18 格不通，和 22 m ÷ 1.2566 = 17.5 一致，不扣（离赤道远格子窄，同样格数更短，只会更宽裕）
/** 覆盖半径与连接距离（格） */
export function powerReach(type, { cellM = CELL_M, coverMargin = COVER_MARGIN, linkMargin = LINK_MARGIN } = {}) {
  const s = POWER[type];
  return { cover: s.cover / cellM - coverMargin, link: s.link / cellM - linkMargin };
}

const K = (x, y) => `${x},${y}`;

/**
 * 被占格子的位图（代替字符串键的 Set）：布局四周留 24 格余量，余量外的格子一律当空。
 * 搜索时每一步都要重建一次，位图比几千次字符串拼接快得多。给了 buf 就借它的前一截（搜索时反复用同一块，省得每步分配）。
 */
function occGrid(W, H, buf = null) {
  const M = 24;
  const GW = W + 2 * M;
  const GH = H + 2 * M;
  const bits = buf ? buf.subarray(0, GW * GH).fill(0) : new Uint8Array(GW * GH);
  return {
    bits,
    GW,
    GH,
    M,
    add(x, y) {
      const gx = x + M;
      const gy = y + M;
      if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) bits[gy * GW + gx] = 1;
    },
    has(x, y) {
      const gx = x + M;
      const gy = y + M;
      return gx >= 0 && gy >= 0 && gx < GW && gy < GH && bits[gy * GW + gx] === 1;
    },
  };
}

/** 目标没有 bid 这个键（物流站、发电厂这些）；有 bid 键、值是 undefined 的照样留着键 */
const NOBID = Symbol('nobid');
/** 需要供电的目标：坐标、what、bid 分开按顺序存，搜索时只给落单的那几个生成对象 */
const sink = () => ({ n: 0, x: [], y: [], what: [], bid: [] });
const put = (T, x, y, what, bid) => {
  const i = T.n++;
  T.x[i] = x;
  T.y[i] = y;
  T.what[i] = what;
  T.bid[i] = bid;
};
const target = (T, i) => (T.bid[i] === NOBID ? { x: T.x[i], y: T.y[i], what: T.what[i] } : { x: T.x[i], y: T.y[i], what: T.what[i], bid: T.bid[i] });

/**
 * 被占的格子（不分高度）与需要供电的目标点。power 是供电设施的物品编号（决定能不能贴着工厂本体放）。
 * 工厂本体左右各多算 1 格（同一行两台之间那 1 格缝也算占用），除非实测过这种设施可以贴着这种工厂放
 * （gamedata.js 的 powerHugs：电力感应塔贴所有工厂；卫星配电站按 substationPad，第六张体积测试）。rowGaps=true 时一律不多算。
 */
export function occupancy(L, { rowGaps = false, power = null } = {}) {
  const occ = occGrid(L.width, L.height);
  const T = sink();
  mark(L, rowGaps, power, occ, T);
  const targets = [];
  for (let i = 0; i < T.n; i++) targets.push(target(T, i));
  return { occ, targets };
}

/** occupancy 的主体：被占的格子记进 occ，需要供电的目标按顺序记进 T（powerBands 搜索时直接用，不生成目标对象） */
function mark(L, rowGaps, power, occ, T) {
  const { bits, GW, GH, M } = occ;
  const add = (x, y) => {
    const gx = x + M;
    const gy = y + M;
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) bits[gy * GW + gx] = 1;
  };
  const cells = (cs) => {
    for (let i = 0; i < cs.length; i++) {
      const gx = cs[i][0] + M;
      const gy = cs[i][1] + M;
      if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) bits[gy * GW + gx] = 1;
    }
  };
  // 第 y 行 x0..x1 这几格，和 for (x = x0; x <= x1; x++) add(x, y) 一样；起点和行号是整数时整段直接写
  const line = (x0, x1, y) => {
    const gy = y + M;
    if (!Number.isInteger(x0) || !Number.isInteger(gy)) {
      for (let x = x0; x <= x1; x++) add(x, y);
      return;
    }
    if (gy < 0 || gy >= GH) return;
    const o = gy * GW;
    for (let gx = Math.max(x0 + M, 0), b = Math.min(x1 + M, GW - 1); gx <= b; gx++) bits[o + gx] = 1;
  };
  for (const p of L.pos.values()) {
    const cy = L.rowCy[p.row];
    const hw = ((p.g.bodyWidth ?? 3) - 1) / 2;
    const below = p.g.bodyBelow ?? ((p.g.bodyHeight ?? 3) - 1) / 2;
    const above = (p.g.bodyHeight ?? 3) - 1 - below;
    // 本体外多算几格：卫星配电站按 gamedata.js 的 substationPad（化工厂左 1 格、下沿 1 行，叠层研究站四周 1 格，对撞机左 2 下 2 右 1 上 1，2026/10/08 实测）；
    // 别的设施能贴就不多算，不能贴左右各 1 格（只看工厂种类，同一组每台都一样，提到循环外）
    const hug = power && powerHugs(power, p.g) ? 0 : 1;
    const sp = rowGaps ? { left: 0, right: 0, below: 0, above: 0 } : power === 2212 ? substationPad(p.g).pad : { left: hug, right: hug, below: 0, above: 0 };
    const exL = sp.below || sp.above ? sp.left : 0;
    const exR = sp.below || sp.above ? sp.right : 0;
    for (const cx of p.centers) {
      for (let y = cy - below; y <= cy + above; y++) line(cx - hw - sp.left, cx + hw + sp.right, y);
      for (let k = 1; k <= sp.below; k++) line(cx - hw - exL, cx + hw + exR, cy - below - k);
      for (let k = 1; k <= sp.above; k++) line(cx - hw - exL, cx + hw + exR, cy + above + k);
      put(T, cx, cy, p.g.item, p.bid);
    }
  }
  // 带子占的格子：和 chainTiles 列出来的那些格一样，只是不拼数组（搜索时每步都要走一遍）
  for (const ch of L.chains)
    for (const part of ch.parts) {
      if (part.leg != null) {
        const l = L.legs[part.leg];
        if (l.kind === 'in' || l.kind === 'out') {
          if (l.stub) cells(l.stub);
          if (l.kind === 'in' && l.pre) cells(l.pre);
          if (!l.direct) add(l.edge, l.py);
        }
        cells(l.cells);
        continue;
      }
      const s = L.segments[part.seg];
      // 和 chainTiles 的 range 一样从一头走到另一头（两头是整数时就是两头之间整段）；劈开的段两半都算
      const span = (from, to) => {
        if (Number.isInteger(from) && Number.isInteger(to)) return line(Math.min(from, to), Math.max(from, to), s.y);
        const step = from <= to ? 1 : -1;
        for (let x = from; step > 0 ? x <= to : x >= to; x += step) add(x, s.y);
      };
      if (s.split == null) {
        if (s.dir > 0) span(s.a, s.b);
        else span(s.b, s.a);
      } else {
        if (s.split > s.a) span(s.split - 1, s.a);
        span(s.split, s.b);
      }
    }
  // 增产剂带（多半在高架上，塔也不能放在它下面）；喷涂机、自动集装机都要通电
  for (const pl of L.proLines || []) cells(pl.cells);
  for (const w of L.warperLinks || []) cells(w.cells); // 翘曲器带
  // 就地烧副产物的火力发电厂（plan/burn.js）：整块地不放供电设施；发电厂要在覆盖范围里才并网，上面的集装分拣器也要电
  for (const b of L.burners || []) {
    // 电力感应塔可以放进列与列之间的缝（bankLanes，推断），进料带那一行除外；别的设施（卫星配电站 3×3）塞不进
    const lanes = new Set(power === 2201 ? bankLanes(b) : []);
    for (let x = b.rect[0]; x <= b.rect[2]; x++) for (let y = b.rect[1]; y <= b.rect[3]; y++) if (!lanes.has(x) || y >= b.feedY) add(x, y);
    for (const [x, y] of b.plants) put(T, x, y, '火力发电厂', NOBID);
    for (const s of bankSorters(b)) put(T, (s.p0[0] + s.p1[0]) / 2, (s.p0[1] + s.p1[1]) / 2, '分拣器', NOBID);
  }
  for (const d of [...(L.coaters || []), ...(L.pilers || [])]) put(T, d.x, d.y, L.coaters?.includes(d) ? '喷涂机' : '自动集装机', NOBID);
  // 物流站占 7×7，外面还有 1 格碰撞圈（只挡卫星配电站，按 9×9 算），自己也耗电
  for (const st of L.stations || []) {
    const c = power === 2212 ? STATION_CLEAR : 3;
    for (let dx = -c; dx <= c; dx++) for (let dy = -c; dy <= c; dy++) add(st.x + dx, st.y + dy);
    put(T, st.x, st.y, '物流站', NOBID);
  }
  // 同一台工厂的分拣器多半挨着排，上一根的工厂直接拿来用，省一次查表
  let bid = NOBID;
  let p = null;
  for (const s of L.sorterList) {
    if (s.bid !== bid) p = L.pos.get((bid = s.bid));
    const seg = L.segments[s.segId];
    const edge = s.side === 'bottom' ? L.rowCy[p.row] - (p.g.edgeBelow ?? 1) : L.rowCy[p.row] + (p.g.edgeAbove ?? 1);
    const lo = Math.min(edge, seg.y);
    const hi = Math.max(edge, seg.y);
    for (let y = lo + 1; y < hi; y++) add(s.col, y);
    // 覆盖按分拣器两端的中点算，和独立检查一致（化工厂下侧落点带 0.284 的小数，研究站、对撞机的分拣器对齐槽位的 x）
    const pt = slotPoint(p.g, s.side, s.col - s.cx);
    put(T, s.cx + pt.dx, (L.rowCy[p.row] + pt.dy + seg.y) / 2, '分拣器', s.bid);
  }
}

const SIDES = ['left', 'right', 'bottom', 'top'];

/** 设施中心在 (x, y) 时实际占的格子，以及离中心最远几格（ring） */
const cellsOf = (spec, x, y) => powerCells(spec.itemId, x, y);
const ringOf = (spec) => (spec.size - 1) / 2;
/** 同类设施两座能不能这样放：中心直线距离不小于 powerGap（配电站 6、塔 2√2，2026/10/05 实测） */
export const apart = (spec, a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 >= powerGap(spec.itemId, spec.itemId) ** 2 - 1e-9;

/** 外沿加地后的范围：x ∈ [x0, x1)，y ∈ [y0, y1) */
const bounds = (W, H, ext) => ({ x0: -ext.left, x1: W + ext.right, y0: -ext.bottom, y1: H + ext.top });

/**
 * 某一侧外沿那条地上的设施中心位置（排除挡住边缘出入口的位置）。设施放在加的那条地里，
 * 每个候选带上它需要加几格宽的地（ext，等于设施边长）。ringOf 留着是为了以后设施实际占地比底座大时，可以往外多挪几格。
 */
function bandCands(L, side, spec, blocked, occ = { has: () => false }) {
  const W = L.width;
  const H = L.height;
  const h = (spec.size - 1) / 2;
  const r = ringOf(spec);
  const out = [];
  for (let k = 1 + h; k <= 1 + r; k++) {
    const ext = k + r;
    if (side === 'left' || side === 'right') {
      const x = side === 'left' ? -k : W - 1 + k;
      for (let y = r; y < H - r; y++) out.push({ x, y, ext });
    } else {
      const y = side === 'bottom' ? -k : H - 1 + k;
      for (let x = r; x < W - r; x++) out.push({ x, y, ext });
    }
  }
  // 工厂紧贴边缘时，它旁边那 1 格空隙（occ 里算作工厂的）也伸到了外沿，设施不能贴着工厂放
  return out.filter((c) => cellsOf(spec, c.x, c.y).every(([x, y]) => !blocked.has(K(x, y)) && !occ.has(x, y)));
}

/** 出入口正外面那一格要留给玩家接带子（已经接到物流站的不用留） */
function portBlocks(L) {
  const b = new Set();
  for (const p of L.ports || []) {
    if (p.station != null) continue;
    if (p.x <= 0) b.add(K(p.x - 1, p.y));
    if (p.x >= L.width - 1) b.add(K(p.x + 1, p.y));
    if (p.y <= 0) b.add(K(p.x, p.y - 1));
    if (p.y >= L.height - 1) b.add(K(p.x, p.y + 1));
  }
  return b;
}

/** powerBands 每步都要用的几块缓冲：位图、每列连了几行空、每行最近的可放格、目标。只在这里借用，不会同时用两次 */
const BUF = { occ: new Uint8Array(0), cnt: new Int32Array(0), prev: new Int32Array(0), next: new Int32Array(0), T: sink() };
const grow = (a, n) => (a.length >= n ? a : new a.constructor(Math.ceil(n * 1.5)));

/**
 * 搜索时用的快速估算：哪些工厂/分拣器附近没有空地放供电设施，只能靠外沿加地；
 * 挑四条边里加地面积最小、又能覆盖它们的组合。
 * @returns {{ext: {left,right,bottom,top}, extraArea: number, unreachable: number}}
 */
export function powerBands(L, type, opt = {}) {
  const spec = POWER[type];
  const { cover } = powerReach(type, opt);
  const W = L.width;
  const H = L.height;
  // 和 occupancy 一样的格子、一样顺序的目标，只是位图借缓冲、目标先不生成对象
  BUF.occ = grow(BUF.occ, (W + 48) * (H + 48));
  const occ = occGrid(W, H, BUF.occ);
  const T = BUF.T;
  T.n = 0;
  const { rowGaps = false } = opt;
  mark(L, rowGaps, spec.itemId, occ, T);
  const h = (spec.size - 1) / 2;
  const r = ringOf(spec); // 等于 h
  const band = 1 + h + r; // 外沿加地的宽度（等于设施边长）
  // 能放设施中心的格子（塔 1 格空、配电站 3×3 全空）。塔直接查位图。
  // 配电站一行一行往上扫：先在这一行数连续空格，得到左右 h 格都空的中心；每列再记这种行往上连了几行，
  // 连满 2h+1 行，中间那一行的这一格就能放。顺手给这一行做两张表：每一列往左（≤ x）、往右（≥ x）最近的可放格，
  // 没有记 -1、W（配电站半径大，落单的目标要扫一大片，先备好表）
  const n = W * H;
  const { bits, GW, M } = occ;
  const table = h > 0;
  let prev = null;
  let next = null;
  if (table) {
    const span = 2 * h + 1;
    const cnt = (BUF.cnt = grow(BUF.cnt, W));
    cnt.fill(0, 0, W);
    prev = BUF.prev = grow(BUF.prev, n);
    next = BUF.next = grow(BUF.next, n);
    // 上下各 h 行放不下中心
    prev.fill(-1, 0, Math.min(n, h * W));
    next.fill(W, 0, Math.min(n, h * W));
    prev.fill(-1, Math.max(0, (H - h) * W), n);
    next.fill(W, Math.max(0, (H - h) * W), n);
    for (let y = 0; y < H; y++) {
      const g = (y + M) * GW + M;
      let k = 0;
      for (let x = 0; x < W; x++) {
        k = bits[g + x] === 1 ? 0 : k + 1;
        if (x >= 2 * h) cnt[x - h] = k >= span ? cnt[x - h] + 1 : 0;
      }
      if (y < 2 * h) continue;
      const row = (y - h) * W;
      let last = -1;
      for (let x = 0; x < W; x++) prev[row + x] = last = cnt[x] >= span ? x : last;
      last = W;
      for (let x = W - 1; x >= 0; x--) next[row + x] = last = cnt[x] >= span ? x : last;
    }
  }
  const R = Math.floor(cover);
  const r2 = cover * cover;
  // 一个目标附近有没有能放的格：原来是把外框 [X0, X1] × [Y0, Y1] 里每格都按 (x − t.x)² + (y − t.y)² ≤ r² 判一遍。
  // 同一行里这个值往 t.x 两边单调不减，所以每行只要看 t.x 左边、右边离它最近的那一格可放格
  // （塔：从 t.x 往两边走，走到第一格可放或第一格超出半径为止；配电站：查表），结果和逐格判一样。
  // 从目标那一行往外找，找到就停。上一个目标找到的那格（wx, wy）先拿来判一下，相邻的目标多半一判就中：
  // 半径不是负数时，外框外的格子至少隔 R + 1.5 格，一定超出半径，所以只要这格在半径内，原来逐格判也会判到它
  const reuse = cover >= 0;
  let wx = NaN;
  let wy = NaN;
  const near = (tx0, ty0) => {
    if (reuse && (wx - tx0) ** 2 + (wy - ty0) ** 2 <= r2) return true;
    const tx = Math.round(tx0);
    const ty = Math.round(ty0);
    const X0 = Math.max(0, tx - R - 1);
    const X1 = Math.min(W - 1, tx + R + 1);
    const Y0 = Math.max(0, ty - R - 1);
    const Y1 = Math.min(H - 1, ty + R + 1);
    if (!(X0 <= X1 && Y0 <= Y1)) return false;
    const xr = Math.max(X0, Math.ceil(tx0)); // 右边从这一列找起
    const xl = Math.min(X1, Math.floor(tx0)); // 左边从这一列找起
    const hit = (y) => {
      const dy2 = (y - ty0) ** 2;
      let x = -1;
      if (table) {
        const row = y * W;
        if (xr <= X1 && next[row + xr] <= X1 && (next[row + xr] - tx0) ** 2 + dy2 <= r2) x = next[row + xr];
        else if (xl >= X0 && prev[row + xl] >= X0 && (prev[row + xl] - tx0) ** 2 + dy2 <= r2) x = prev[row + xl];
      } else {
        const g = (y + M) * GW + M;
        for (let c = xr; x < 0 && c <= X1 && (c - tx0) ** 2 + dy2 <= r2; c++) if (bits[g + c] !== 1) x = c;
        for (let c = xl; x < 0 && c >= X0 && (c - tx0) ** 2 + dy2 <= r2; c--) if (bits[g + c] !== 1) x = c;
      }
      if (x < 0) return false;
      wx = x;
      wy = y;
      return true;
    };
    for (let d = 0, D = Math.max(Y1 - ty, ty - Y0); d <= D; d++) {
      if (ty + d >= Y0 && ty + d <= Y1 && hit(ty + d)) return true;
      if (d && ty - d >= Y0 && ty - d <= Y1 && hit(ty - d)) return true;
    }
    return false;
  };
  const lonely = [];
  for (let i = 0; i < T.n; i++) if (!near(T.x[i], T.y[i])) lonely.push(target(T, i));
  const none = { left: 0, right: 0, bottom: 0, top: 0 };
  if (!lonely.length) return { ext: none, extraArea: 0, unreachable: 0, lonely };
  // 每条边能够着哪些：设施中心离这条边外面那条地的距离 ≤ 覆盖半径（沿边方向随便挪）
  const reach = {
    left: (t) => t.x + 1 + h <= cover,
    right: (t) => W + h - t.x <= cover,
    bottom: (t) => t.y + 1 + h <= cover,
    top: (t) => H + h - t.y <= cover,
  };
  // 每个落单的目标能被哪几条边够着，按 SIDES 的顺序记成 4 位；下面 16 种加地组合只数位
  const sides = lonely.map((t) => SIDES.reduce((a, sd, i) => (reach[sd](t) ? a | (1 << i) : a), 0));
  let best = null;
  for (let m = 0; m < 16; m++) {
    const ext = { ...none };
    SIDES.forEach((sd, i) => (ext[sd] = m & (1 << i) ? band : 0));
    if (opt.maxWidth && W + ext.left + ext.right > opt.maxWidth && (ext.left || ext.right)) continue; // 限宽时不往左右加地
    if (opt.maxHeight && H + ext.bottom + ext.top > opt.maxHeight && (ext.bottom || ext.top)) continue; // 限长时不往上下加地
    let miss = 0;
    for (const s of sides) if (!(s & m)) miss++;
    const extraArea = (W + ext.left + ext.right) * (H + ext.bottom + ext.top) - W * H;
    if (!best || miss < best.unreachable || (miss === best.unreachable && extraArea < best.extraArea)) best = { ext, extraArea, unreachable: miss, lonely };
  }
  return best;
}

/**
 * @param L route() 的布局
 * @param {'tesla'|'substation'} type
 * @returns {{type, itemId, model, size, nodes: {x,y}[], extend: {left,right,bottom,top}, uncovered: number, warnings: string[]}}
 */
export function placePower(L, type, opt = {}) {
  const spec = POWER[type];
  if (!spec) throw new Error(`未知供电方式 ${type}`);
  const { cover, link } = powerReach(type, opt);
  const { occ, targets } = occupancy(L, { ...opt, power: spec.itemId });
  const W = L.width;
  const H = L.height;
  const h = (spec.size - 1) / 2;
  const blocked = portBlocks(L);
  const r2 = cover * cover;
  // 一个位置覆盖哪些目标（下标从小到大）。目标按 BS 格见方分桶，只看覆盖半径多算 1 格以内的那几桶：
  // 半径内的目标一定落在这几桶里，判断式和逐个看一模一样，最后按下标排序，结果和逐个筛出来的一样。
  // 坐标不是有限数的目标原来的判断式永远不成立（谁也覆盖不到），不进桶
  const BS = 8;
  const finite = (t) => Number.isFinite(t.x) && Number.isFinite(t.y);
  let tx0 = Infinity;
  let ty0 = Infinity;
  let tx1 = -Infinity;
  let ty1 = -Infinity;
  for (const t of targets) {
    if (!finite(t)) continue;
    tx0 = Math.min(tx0, t.x);
    ty0 = Math.min(ty0, t.y);
    tx1 = Math.max(tx1, t.x);
    ty1 = Math.max(ty1, t.y);
  }
  const nbx = tx0 <= tx1 ? Math.floor((tx1 - tx0) / BS) + 1 : 0;
  const nby = ty0 <= ty1 ? Math.floor((ty1 - ty0) / BS) + 1 : 0;
  const buckets = Array.from({ length: nbx * nby }, () => []);
  targets.forEach((t, i) => {
    if (finite(t)) buckets[Math.floor((t.y - ty0) / BS) * nbx + Math.floor((t.x - tx0) / BS)].push(i);
  });
  const CR = Math.abs(cover) + 1; // 判断式里是半径的平方，半径按绝对值算
  const covers = (c) => {
    const out = [];
    const bx0 = Math.max(0, Math.floor((c.x - CR - tx0) / BS));
    const bx1 = Math.min(nbx - 1, Math.floor((c.x + CR - tx0) / BS));
    const by0 = Math.max(0, Math.floor((c.y - CR - ty0) / BS));
    const by1 = Math.min(nby - 1, Math.floor((c.y + CR - ty0) / BS));
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++)
        for (const i of buckets[by * nbx + bx]) {
          const t = targets[i];
          if ((t.x - c.x) ** 2 + (t.y - c.y) ** 2 <= r2) out.push(i);
        }
    return out.sort((a, b) => a - b);
  };
  /**
   * 贪心选址：每轮挑能新覆盖最多目标的位置（一样多时挑离已选设施更远的，免得扎堆；再一样挑靠前的），和已有的、已选的设施都要隔够距离（apart）。
   * 每个位置还能新覆盖几个（cnt）、隔得够不够（ok）、离已选设施最近的距离平方（sp）都随选中一座更新，不再每轮整个重算；
   * 每轮比较的数和挑法和逐个重算一模一样（sp 在还没选时是 +∞，比不出大小，和原来距离都算 0 一样）
   */
  const greedy = (cands, need, have = []) => {
    for (const c of cands) c.cov ??= covers(c);
    const picked = [];
    const m = cands.length;
    const cnt = new Int32Array(m);
    const ok = new Uint8Array(m);
    const sp = new Float64Array(m).fill(Infinity);
    const rev = new Map(); // 目标 → 覆盖它的位置（从小到大）
    for (let k = 0; k < m; k++) {
      const c = cands[k];
      ok[k] = have.every((p) => apart(spec, p, c)) ? 1 : 0; // 两座配电站离太近
      for (const i of c.cov) {
        if (need.has(i)) cnt[k]++;
        let r = rev.get(i);
        if (!r) rev.set(i, (r = []));
        r.push(k);
      }
    }
    while (need.size) {
      let best = -1;
      let bn = 0;
      for (let k = 0; k < m; k++) {
        if (!ok[k]) continue;
        const n = cnt[k];
        if (n > bn || (n === bn && n > 0 && best >= 0 && sp[k] > sp[best])) {
          best = k;
          bn = n;
        }
      }
      if (best < 0) break;
      const b = cands[best];
      picked.push(b);
      for (const i of b.cov)
        if (need.delete(i)) for (const k of rev.get(i)) cnt[k]--;
      for (let k = 0; k < m; k++) {
        const c = cands[k];
        if (ok[k] && !apart(spec, b, c)) ok[k] = 0;
        const d2 = (b.x - c.x) ** 2 + (b.y - c.y) ** 2;
        if (d2 < sp[k]) sp[k] = d2;
      }
    }
    return picked;
  };
  // 设施实际占的格子（配电站 5×5 去四角）都在外框里、都空着
  const freeIn = (x, y, b) => cellsOf(spec, x, y).every(([cx, cy]) => cx >= b.x0 && cy >= b.y0 && cx < b.x1 && cy < b.y1 && !occ.has(cx, cy) && !blocked.has(K(cx, cy)));
  const inner = [];
  const b0 = bounds(W, H, { left: 0, right: 0, bottom: 0, top: 0 });
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (freeIn(x, y, b0)) inner.push({ x, y });
  const need = new Set(targets.map((_, i) => i));
  // 搜索时在行里挪开工厂挖出来的配电站空位（layout/powerholes.js）都放上、后面也不删：空位是为它挪的，不放就白留一段缝；
  // 还没覆盖的再在所有空地里挑
  let nodes = [];
  for (const h of L.powerHoles ?? []) {
    if (!(h.shift > 0)) continue;
    const c = inner.find((q) => q.x === h.x && q.y === L.rowCy[h.row]);
    if (!c || !nodes.every((p) => apart(spec, p, c))) continue;
    c.cov ??= covers(c);
    for (const i of c.cov) need.delete(i);
    nodes.push(c);
  }
  const fixed = new Set(nodes);
  nodes = nodes.concat(greedy(inner, need, nodes));
  const extend = { left: 0, right: 0, bottom: 0, top: 0 };
  if (need.size) {
    // 布局里够不着的，用估算挑出的那几条边的外沿
    const plan = powerBands(L, type, opt);
    const add = (sides) => {
      const cands = sides.flatMap((sd) => bandCands(L, sd, spec, blocked, occ).map((c) => ({ ...c, side: sd })));
      const got = greedy(cands, need, nodes);
      nodes = nodes.concat(got);
      for (const c of got) extend[c.side] = Math.max(extend[c.side], c.ext);
    };
    add(SIDES.filter((sd) => plan.ext[sd]));
    // 估算挑的边上没有空位（比如被出入口挡住）时，再试别的边；限宽 / 限长时不往那个方向加地
    const band = 1 + h + ringOf(spec);
    const fits = (sd) => (sd === 'left' || sd === 'right' ? !opt.maxWidth || W + band <= opt.maxWidth : !opt.maxHeight || H + band <= opt.maxHeight);
    if (need.size) add(SIDES.filter((sd) => !plan.ext[sd] && fits(sd)));
  }
  // 倒序删掉多余的：它覆盖的目标别的设施都覆盖了
  const count = new Map();
  for (const c of nodes) for (const i of c.cov) count.set(i, (count.get(i) || 0) + 1);
  for (let j = nodes.length - 1; j >= 0; j--) {
    const c = nodes[j];
    if (!fixed.has(c) && c.cov.every((i) => count.get(i) > 1)) {
      for (const i of c.cov) count.set(i, count.get(i) - 1);
      nodes.splice(j, 1);
    }
  }
  // 2 换 1：两座设施各自独占的目标，如果某个空位能全部覆盖，就换成那一座。反复做到换不动为止
  if (opt.localSearch !== false) {
    const pool = inner.concat(nodes.filter((n) => n.side));
    // 目标 → 覆盖它的空位（按 pool 里的先后）。要找的空位得覆盖 only 里每一个，当然也覆盖 only[0]：只看覆盖 only[0] 的那些，
    // 按先后找第一个满足条件的，和整个 pool 从头找是同一个。目标集合（set）用到时才建
    const revPool = new Map();
    pool.forEach((c, k) => {
      c.cov ??= covers(c);
      for (const i of c.cov) {
        let r = revPool.get(i);
        if (!r) revPool.set(i, (r = []));
        r.push(k);
      }
    });
    const setOf = (c) => (c.set ??= new Set(c.cov));
    for (const c of nodes) setOf(c);
    const cnt = new Map();
    for (const c of nodes) for (const i of c.cov) cnt.set(i, (cnt.get(i) || 0) + 1);
    const reach2 = (2 * cover) ** 2;
    let again = true;
    while (again) {
      again = false;
      outer: for (let a = 0; a < nodes.length; a++)
        for (let b = a + 1; b < nodes.length; b++) {
          const A = nodes[a];
          const B = nodes[b];
          if (fixed.has(A) || fixed.has(B) || (A.x - B.x) ** 2 + (A.y - B.y) ** 2 > reach2) continue;
          const only = [];
          for (const i of A.cov) if (cnt.get(i) - 1 - (B.set.has(i) ? 1 : 0) === 0) only.push(i);
          for (const i of B.cov) if (!A.set.has(i) && cnt.get(i) === 1) only.push(i);
          const fit = (c) => c !== A && c !== B && only.every((i) => setOf(c).has(i)) && !nodes.some((n) => n !== A && n !== B && !apart(spec, n, c));
          let sub;
          if (only.length) {
            for (const k of revPool.get(only[0]) ?? []) if (fit(pool[k])) {
              sub = pool[k];
              break;
            }
          } else sub = pool.find(fit);
          if (!sub) continue;
          setOf(sub); // 换上去的设施以后当 A、B 用
          for (const i of A.cov) cnt.set(i, cnt.get(i) - 1);
          for (const i of B.cov) cnt.set(i, cnt.get(i) - 1);
          for (const i of sub.cov) cnt.set(i, (cnt.get(i) || 0) + 1);
          nodes.splice(b, 1);
          nodes.splice(a, 1, sub);
          again = true;
          break outer;
        }
    }
    // 再删一次多余的
    for (let j = nodes.length - 1; j >= 0; j--) {
      const c = nodes[j];
      if (!fixed.has(c) && c.cov.every((i) => cnt.get(i) > 1)) {
        for (const i of c.cov) cnt.set(i, cnt.get(i) - 1);
        nodes.splice(j, 1);
      }
    }
  }
  for (const sd of SIDES) extend[sd] = Math.max(0, ...nodes.filter((n) => n.side === sd).map((n) => n.ext));
  // 连通：超出连接距离的几群之间补中继
  const b1 = bounds(W, H, extend);
  const l2 = link * link;
  const warnings = [];
  for (let guard = 0; guard < 20; guard++) {
    const comp = new Array(nodes.length).fill(-1);
    let nc = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (comp[i] >= 0) continue;
      const st = [i];
      comp[i] = nc;
      while (st.length) {
        const a = st.pop();
        for (let b = 0; b < nodes.length; b++)
          if (comp[b] < 0 && (nodes[a].x - nodes[b].x) ** 2 + (nodes[a].y - nodes[b].y) ** 2 <= l2) {
            comp[b] = nc;
            st.push(b);
          }
      }
      nc++;
    }
    if (nc <= 1) break;
    let pair = null;
    for (let a = 0; a < nodes.length; a++)
      for (let b = 0; b < nodes.length; b++)
        if (comp[a] === 0 && comp[b] > 0) {
          const d = (nodes[a].x - nodes[b].x) ** 2 + (nodes[a].y - nodes[b].y) ** 2;
          if (!pair || d < pair.d) pair = { a: nodes[a], b: nodes[b], d };
        }
    let relay = null;
    for (let x = b1.x0; x < b1.x1; x++)
      for (let y = b1.y0; y < b1.y1; y++) {
        if (!freeIn(x, y, b1) || nodes.some((n) => !apart(spec, n, { x, y }))) continue;
        const da = (x - pair.a.x) ** 2 + (y - pair.a.y) ** 2;
        const db = (x - pair.b.x) ** 2 + (y - pair.b.y) ** 2;
        if (da <= l2 && db <= l2 && (!relay || Math.max(da, db) < relay.m)) relay = { x, y, m: Math.max(da, db) };
      }
    if (!relay) {
      warnings.push(`${spec.name}分成了互不相连的几群，找不到放中继的空地，贴好后请手动补一座`);
      break;
    }
    nodes.push({ x: relay.x, y: relay.y, cov: [] });
  }
  if (need.size) warnings.push(`有 ${need.size} 个工厂/分拣器不在${spec.name}范围内`);
  return { options: { rowGaps: !!opt.rowGaps }, type, name: spec.name, itemId: spec.itemId, model: spec.model, size: spec.size, cover, link, nodes: nodes.map(({ x, y }) => ({ x, y })), extend, uncovered: need.size, warnings };
}

/**
 * 放好供电，并把外沿加地计入布局尺寸（就地修改 L）。
 * 左侧、下方加地时坐标原点不动，设施坐标为负；出蓝图时整体平移 L.origin。
 */
export function addPower(L, type, opt) {
  if (!type || type === 'none') return L;
  const P = placePower(L, type, opt);
  L.power = P;
  const e = P.extend;
  L.origin = { x: e.left, y: e.bottom };
  L.width += e.left + e.right;
  L.height += e.bottom + e.top;
  L.area = L.width * L.height;
  return L;
}
