// 分馏阵列压紧：array.js 裁完、重新编号之前，直接改 all / removed（新放的电塔追加到 all 末尾，标签记进 tags）。
// 只有两种动作，链接全保留：
//   删线 tryLine：删第 c 行（列），或只删其中一段（= 剪切平移）。线上只许有顺着挪动方向直通的带子（删掉，前一节直接接后一节）
//     和电塔（留在原地，挪过来压到它的那一格得空）；一侧（剪切时只是那一段里的）整体朝线挪一格。挪动的和不挪的之间只能经删掉的带子相连；
//     挪完不能有新的格子重叠、新的建造盒碰撞；剪切时供电覆盖、电塔连通不能断（整行整列删只会变近）。
//   电塔：删多余的；全部拿掉重放。
// 顺序（2026/10/26 试出来最好的）：删行 → 删多余电塔 → 删行 → 站往循环那边剪切 → 删列 → 电塔重放后再删列、删行（包围盒变小、两边都没变长才留）。
import { CELL_M, powerReach } from '../plan/power.js';

const ST = 2104;
const FRAC = 2314;
const PILER = 2040;
const COATER = 2313;
const SPLIT = 2020;
const TESLA = 2201;
const POWERED = [FRAC, PILER, COATER, SPLIT, ST];
const isBelt = (b) => b.itemId >= 2001 && b.itemId <= 2003;
const P = (b) => b.localOffset[0];
const RX = (b) => Math.round(P(b).x);
const RY = (b) => Math.round(P(b).y);
const half = (b) => (b.itemId === ST ? 3 : b.itemId === FRAC ? 1 : 0); // 占格：站 7×7、塔 3×3、别的 1 格
const device = (b) => !isBelt(b) && b.itemId !== TESLA;
const elev = (b) => isBelt(b) && P(b).z > 0.25;
const K = (x, y) => (x + 512) * 2048 + y + 512; // 格子的数字键
const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);

// 建造盒（米）：游戏数据里的 build 碰撞体（out/colliders，2026/10/24，没实测，推断）。每块 [中心 x、高、z，半宽 x、高、z]，z 是朝向 0 时的南北向；
// 外框就是原来的 BODY（分馏塔 4.5 m 见方、集装机顺着带子 2.9 m 长……），物流站、分流器是十字形的两块
const BOX = {
  [FRAC]: [[0, 4.5, 0, 2.25, 4.5, 2.25]],
  [TESLA]: [[0, 2.9, 0, 0.3, 2.9, 0.3]],
  [ST]: [[0, 13, 0, 4, 13, 2.75], [0, 13, 0, 2.75, 13, 4]],
  [PILER]: [[0, 1.26, 0.6, 0.5, 1.26, 0.775], [0, 0.5, 0, 0.5, 0.5, 1.45]],
  [COATER]: [[0, 0.45, 0.15, 0.35, 0.45, 1.75], [0, 1.25, -0.6, 0.35, 1.25, 1]],
  [SPLIT]: [[0, 1.15, 0, 0.625, 1.15, 1.19], [0, 1.15, 0, 1.19, 1.15, 0.625]],
};
// 非赤道格子变窄，按 0.85 留余量（推断，原图在 0.845 以上才干净）：判碰撞时东西向（x）的格宽按赤道一格 × 0.85 算
const XS = 0.85;
const HZ = 1.3333333; // 高度 z 每 1 是多少米
const BELT_R = 0.23; // 带子：带子点往上 0.2 m、半径 0.23 m 的球
const TESLA_GAP2 = 12.25; // 电塔之间中心距 < 3.5 m 放不下
// 水平方向离中心最远多少米（几块盒子的外框；带子是球的半径）：两座隔得比两个加起来还远就不可能撞（电塔之间按 3.5 m）
const REACH = { [FRAC]: 2.25, [TESLA]: 0.3, [ST]: 4, [PILER]: 1.45, [COATER]: 1.9, [SPLIT]: 1.19 };
const reachOf = (b) => (isBelt(b) ? BELT_R : REACH[b.itemId] ?? 0);
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];
const quarter = (b) => ((Math.round(b.yaw[0] / 90) % 4) + 4) % 4;

/** 两座设备的建造盒（几块里任意两块）三个方向都重叠（贴着也算）就撞 */
function boxHit(a, pa, b, pb) {
  const A = BOX[a.itemId], B = BOX[b.itemId];
  if (!A || !B) return false;
  const qa = quarter(a), qb = quarter(b);
  const ca = COS[qa], sa = SIN[qa], cb = COS[qb], sb = SIN[qb];
  const xa = pa.x * CELL_M * XS, ya = pa.y * CELL_M, za = 0.2 + (pa.z ?? 0) * HZ;
  const xb = pb.x * CELL_M * XS, yb = pb.y * CELL_M, zb = 0.2 + (pb.z ?? 0) * HZ;
  for (const [p0, p1, p2, e0, e1, e2] of A) {
    const ax = xa + ca * p0 + sa * p2, ay = ya - sa * p0 + ca * p2;
    const aex = Math.abs(ca) * e0 + Math.abs(sa) * e2, aey = Math.abs(sa) * e0 + Math.abs(ca) * e2;
    const ah0 = za + p1 - e1, ah1 = za + p1 + e1;
    for (const [q0, q1, q2, f0, f1, f2] of B) {
      const bx = xb + cb * q0 + sb * q2, by = yb - sb * q0 + cb * q2;
      if (Math.abs(ax - bx) > aex + Math.abs(cb) * f0 + Math.abs(sb) * f2) continue;
      if (Math.abs(ay - by) > aey + Math.abs(sb) * f0 + Math.abs(cb) * f2) continue;
      if (ah0 <= zb + q1 + f1 && zb + q1 - f1 <= ah1) return true;
    }
  }
  return false;
}
/** 带子的球碰设备 o 的建造盒 */
function sphereHit(pt, o, po) {
  const B = BOX[o.itemId];
  if (!B) return false;
  const q = quarter(o), c = COS[q], s = SIN[q];
  const cx = pt.x * CELL_M * XS, cy = pt.y * CELL_M, ch = 0.2 + (pt.z ?? 0) * HZ + 0.2;
  const xb = po.x * CELL_M * XS, yb = po.y * CELL_M, zb = 0.2 + (po.z ?? 0) * HZ;
  for (const [q0, q1, q2, f0, f1, f2] of B) {
    const dx = Math.max(0, Math.abs(cx - (xb + c * q0 + s * q2)) - (Math.abs(c) * f0 + Math.abs(s) * f2));
    const dy = Math.max(0, Math.abs(cy - (yb - s * q0 + c * q2)) - (Math.abs(s) * f0 + Math.abs(c) * f2));
    const h0 = zb + q1 - f1, h1 = zb + q1 + f1;
    const dh = ch < h0 ? h0 - ch : ch > h1 ? ch - h1 : 0;
    if (dx * dx + dy * dy + dh * dh <= BELT_R * BELT_R) return true;
  }
  return false;
}
/**
 * a、b 放在 pa、pb（格，带 z）撞不撞：设备之间比建造盒；带子按球碰设备的盒子，顺着链接 3 跳以内的设备、喷涂机（带子附件）放行；
 * 带子和带子不查（游戏也不查）；电塔之间中心距 < 3.5 m 撞。hops(a, b) 给两者在链接上隔几跳
 */
function collide(a, pa, b, pb, hops) {
  const ba = isBelt(a), bb = isBelt(b);
  if (ba && bb) return false;
  if (a.itemId === TESLA && b.itemId === TESLA && ((pa.x - pb.x) * XS) ** 2 * CELL_M * CELL_M + (pa.y - pb.y) ** 2 * CELL_M * CELL_M < TESLA_GAP2) return true;
  if (ba || bb) {
    const [belt, pt, o, po] = ba ? [a, pa, b, pb] : [b, pb, a, pa];
    if (o.itemId === COATER) return false;
    return sphereHit(pt, o, po) && hops(belt, o) > 3;
  }
  return boxHit(a, pa, b, pb);
}
/** 链接图（无向）上的跳数，最多数到 4；nb(i) 给第 i 座的邻居 */
function hopsOn(nb) {
  return (a, b) => {
    let front = [a.index];
    const seen = new Set(front);
    for (let h = 1; h <= 3; h++) {
      const next = [];
      for (const u of front) for (const v of nb(u)) {
        if (v === b.index) return h;
        if (!seen.has(v)) { seen.add(v); next.push(v); }
      }
      front = next;
    }
    return 4;
  };
}
/** 邻接表（无向）：list 里每座的 outputObjIdx、inputObjIdx 指向 get 认的建筑就连一条边 */
function adjacency(list, get) {
  const nb = new Map();
  for (const b of list) for (const i of [b.outputObjIdx, b.inputObjIdx]) {
    const o = get(i);
    if (o) { push(nb, b.index, o.index); push(nb, o.index, b.index); }
  }
  return nb;
}

/** 整张图两两扫一遍建造盒碰撞（同上的规则，B 按 index 排好）：撞的对子 [i, j] */
export function collisions(B) {
  const nb = adjacency(B, (i) => (i >= 0 ? B[i] : null));
  const hops = hopsOn((u) => nb.get(u) ?? []);
  const pos = B.map(P);
  const order = B.map((_, i) => i).sort((i, j) => pos[i].x - pos[j].x);
  const out = [];
  for (let u = 0; u < order.length; u++) {
    const i = order[u];
    for (let v = u + 1; v < order.length && pos[order[v]].x - pos[i].x <= 7; v++) {
      const j = order[v];
      if (Math.abs(pos[i].y - pos[j].y) > 7) continue;
      const [a, b] = i < j ? [i, j] : [j, i];
      if (collide(B[a], pos[a], B[b], pos[b], hops)) out.push([a, b]);
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

// ---- 压紧用的状态 S = { all, removed, tags, get, live, memo }：live 和下面几个索引每改一次重算 ----
function refresh(S) {
  S.live = S.all.filter((b) => !S.removed.has(b.index));
  S.memo = {};
}
const memo = (S, k, f) => S.memo[k] ?? (S.memo[k] = f());
/** 格子 → 压着它的建筑（地面、高架都算） */
const cellsOf = (S) => memo(S, 'cells', () => {
  const m = new Map();
  for (const b of S.live) {
    const h = half(b), x = RX(b), y = RY(b);
    for (let dx = -h; dx <= h; dx++) for (let dy = -h; dy <= h; dy++) push(m, K(x + dx, y + dy), b);
  }
  return m;
});
/** 第几列（axis 'x'）/ 行（'y'）→ 压着它的建筑 */
const linesOf = (S, axis) => memo(S, axis, () => {
  const m = new Map();
  const A = axis === 'x' ? RX : RY;
  for (const b of S.live) for (let i = -half(b); i <= half(b); i++) push(m, A(b) + i, b);
  return m;
});
/** 带子 → 接进它的带子 */
const predsOf = (S) => memo(S, 'preds', () => {
  const m = new Map();
  for (const b of S.live) if (isBelt(b) && S.get(b.outputObjIdx)) push(m, b.outputObjIdx, b);
  return m;
});
/** 留着的链接 [从, 到]：outputObjIdx 是 b → o，inputObjIdx 是 o → b */
const edgesOf = (S) => memo(S, 'edges', () => {
  const out = [];
  for (const b of S.live) {
    const o = S.get(b.outputObjIdx);
    if (o) out.push([b, o]);
    const i = S.get(b.inputObjIdx);
    if (i) out.push([i, b]);
  }
  return out;
});
/** 第几列 / 行 → 两头跨过（或压着）它的链接 */
const edgesAt = (S, axis) => memo(S, `e${axis}`, () => {
  const m = new Map();
  const A = axis === 'x' ? RX : RY;
  for (const e of edgesOf(S)) for (let i = Math.min(A(e[0]), A(e[1])); i <= Math.max(A(e[0]), A(e[1])); i++) push(m, i, e);
  return m;
});
const adjOf = (S) => memo(S, 'adj', () => adjacency(S.live, S.get));
/** 按块（4 格）分好的建筑：[非带子, 带子] */
const blocksOf = (S) => memo(S, 'blocks', () => {
  const m = [new Map(), new Map()];
  for (const b of S.live) push(m[+isBelt(b)], K(Math.floor(P(b).x / 4), Math.floor(P(b).y / 4)), b);
  return m;
});
/**
 * 块里离 (x, y) 够得着（r 米以内，换成格：东西向按窄了的格宽，再留 0.01 格）、两个方向都在 7 格以内、f 认的有没有。
 * r 取这一座和对面那类里最远的加起来，比它远的撞不上，所以只是少算、结果不变
 */
const span = (r) => [Math.min(7, r / (CELL_M * XS) + 0.01), Math.min(7, r / CELL_M + 0.01)];
function near(m, x, y, r, f) {
  const [rx, ry] = span(r);
  for (let bx = Math.floor((x - rx) / 4); bx <= Math.floor((x + rx) / 4); bx++) {
    for (let by = Math.floor((y - ry) / 4); by <= Math.floor((y + ry) / 4); by++) {
      for (const b of m.get(K(bx, by)) ?? []) if (Math.abs(x - P(b).x) <= rx && Math.abs(y - P(b).y) <= ry && f(b)) return true;
    }
  }
  return false;
}
/** 查设备时的半径：这一座够得着的 + 最大的物流站（电塔之间 3.5 m）；查带子时：这一座 + 带子的球 */
const toSolid = (b) => Math.max(reachOf(b) + REACH[ST], b.itemId === TESLA ? Math.sqrt(TESLA_GAP2) : 0);
const toBelt = (b) => reachOf(b) + BELT_R;
function bbox(S) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of S.live) {
    const h = half(b);
    x0 = Math.min(x0, RX(b) - h); y0 = Math.min(y0, RY(b) - h);
    x1 = Math.max(x1, RX(b) + h); y1 = Math.max(y1, RY(b) + h);
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const stationOf = (S) => S.live.find((b) => b.itemId === ST);
/** 同一格上两座建筑冲突吗：地面对地面冲突；高架带和非带子冲突；两条高架同高冲突；高架压地面带不冲突 */
function cellClash(a, b) {
  const ea = elev(a), eb = elev(b);
  if (!ea && !eb) return true;
  if (ea && eb) return Math.abs(P(a).z - P(b).z) < 0.25;
  return !isBelt(ea ? b : a);
}

const ON = 1, MOV = 2, GONE = 4; // shift 里给建筑打的记号：在线上、挪动、删掉
/** 剪切那一段：碰到、整个在里面 */
const spanOf = (axis, range) => {
  const O = axis === 'x' ? RY : RX; // 另一根轴
  return {
    touches: (b) => !range || (O(b) + half(b) >= range[0] && O(b) - half(b) <= range[1]),
    inside: (b) => !range || (O(b) - half(b) >= range[0] && O(b) + half(b) <= range[1]),
  };
};
/**
 * 删一条线，前一半（和往哪边挪无关）：axis 'y' 删第 c 行（带子要竖直直通）、'x' 删第 c 列（带子要水平直通）；
 * range [lo, hi]：只删另一根轴上这一段。线上不对就给 null，对就给线上的带子（连前后两节）和电塔，交给 shift
 */
function lineAt(S, axis, c, range = null) {
  const X = axis === 'x';
  const A = X ? RX : RY; // 删线方向上的坐标
  const O = X ? RY : RX;
  const { touches, inside } = spanOf(axis, range);
  // 线上只许有带子和电塔（跨在剪切那一段边上的也不行）
  const onLine = [];
  for (const b of linesOf(S, axis).get(c) ?? []) {
    if (!touches(b)) continue;
    if (!inside(b) || (!isBelt(b) && b.itemId !== TESLA)) return null;
    onLine.push(b);
  }
  const cells = cellsOf(S);
  const at = (x, y) => cells.get(K(x, y)) ?? [];
  // 线上的带子：前一节正好一节、没有设备往里送、后一节在线另一边同一根轴上，同高；前后两格都是设备的不删（设备之间至少留一节带子）
  const preds = predsOf(S);
  const links = [], teslas = [];
  for (const b of onLine) {
    if (b.itemId === TESLA) { teslas.push(b); continue; }
    const pr = preds.get(b.index) ?? [];
    const n = S.get(b.outputObjIdx);
    if (pr.length !== 1 || S.get(b.inputObjIdx) || !n) return null;
    const a = pr[0];
    if (O(a) !== O(b) || O(n) !== O(b) || Math.abs(A(a) - c) !== 1 || A(a) + A(n) !== 2 * c) return null;
    // 同一高度：站口出来那几节带子高 0.01~0.02，删列时和地面算一层（照原来的 shrinkCols 按 0.1）；删行照原来的 shrinkRows 按 0.01
    if ([a, n].some((q) => isBelt(q) && Math.abs(P(q).z - P(b).z) > (X ? 0.1 : 0.01))) return null;
    const prev = X ? at(c - 1, RY(b)) : at(RX(b), c - 1);
    const next = X ? at(c + 1, RY(b)) : at(RX(b), c + 1);
    if (prev.some(device) && next.some(device)) return null;
    links.push([b, a, n]);
  }
  return { axis, c, range, onLine, links, teslas };
}
/**
 * 删一条线，后一半：line（lineAt 给的）那条线删掉，side 那一侧（+1 = 坐标大于 c 的那侧朝 −1 挪，−1 = 小于 c 的那侧朝 +1 挪；
 * 剪切时只是那一段里的）整体朝线挪一格。挪不了给 null；挪得了给 { links, moving, apply }（apply() 才真改）
 */
function shift(S, { axis, c, range, onLine, links, teslas }, side) {
  const X = axis === 'x';
  const A = X ? RX : RY;
  const { touches, inside } = spanOf(axis, range);
  const cells = cellsOf(S);
  const at = (x, y) => cells.get(K(x, y)) ?? [];
  // 线上的电塔留在原地：挪过来压到它的那一格得全空（连高架也不能有）
  for (const t of teslas) if ((X ? at(c + side, RY(t)) : at(RX(t), c + side)).length) return null;
  const mark = new Uint8Array(S.all.length);
  for (const b of onLine) mark[b.index] |= ON;
  for (const [b] of links) mark[b.index] |= GONE;
  const moving = [];
  for (const b of S.live) {
    if (mark[b.index] & ON || side * (A(b) - c) <= 0 || !touches(b)) continue;
    if (!inside(b)) return null; // 跨在剪切那一段的边上
    mark[b.index] |= MOV;
    moving.push(b);
  }
  // 挪动部分和不挪部分之间的链接只能经过线上删掉的带子（整条线删时两头在线同一边的都一起挪或都不挪，只看跨过线的）
  const through = new Set();
  for (const [b, a, n] of links) through.add(a.index * 65536 + b.index).add(b.index * 65536 + n.index);
  for (const [u, v] of range ? edgesOf(S) : edgesAt(S, axis).get(c) ?? []) {
    if (through.has(u.index * 65536 + v.index)) continue;
    if ((mark[u.index] | mark[v.index]) & ON) {
      if (u.itemId === TESLA || v.itemId === TESLA) continue;
      return null;
    }
    if ((mark[u.index] & MOV) !== (mark[v.index] & MOV)) return null;
  }
  const d = -side; // 挪动方向
  const dx = X ? d : 0, dy = X ? 0 : d;
  const stays = (o) => !(mark[o.index] & (MOV | GONE));
  // 挪完的重叠：挪动的和不挪的挪完同格、挪之前不同格，就不能冲突（不挪的都占在线那头，只有紧挨着线的那一排够得着）
  for (const m of moving) {
    const h = half(m), x = RX(m), y = RY(m);
    if (side * (A(m) - c) > h + 1) continue;
    let before = null;
    for (let ix = -h; ix <= h; ix++) for (let iy = -h; iy <= h; iy++) {
      for (const o of at(x + ix + dx, y + iy + dy)) {
        if (!stays(o) || !cellClash(m, o)) continue;
        if (!before) {
          before = new Set();
          for (let jx = -h; jx <= h; jx++) for (let jy = -h; jy <= h; jy++) for (const q of at(x + jx, y + jy)) before.add(q);
        }
        if (!before.has(o)) return null;
      }
    }
  }
  // 建造盒：挪完撞、挪之前不撞的不行（跳数按删掉直通带子、前一节直接接后一节以后的链接算）
  let hops = null;
  const hop = (a, b) => {
    if (!hops) {
      const base = adjOf(S), extra = new Map();
      for (const [, p, n] of links) { push(extra, p.index, n.index); push(extra, n.index, p.index); }
      hops = hopsOn((u) => (base.get(u) ?? []).filter((v) => !(mark[v] & GONE)).concat(extra.get(u) ?? []));
    }
    return hops(a, b);
  };
  const [solid, belts] = blocksOf(S);
  // 整条线删：不挪的都在线那头（取整以后差不到半格），离线比够得着的还远的挪动建筑撞不上；近的先查（撞了早停）
  const off = (a) => side * ((X ? P(a).x + dx : P(a).y + dy) - c);
  const check = range ? moving : moving.filter((a) => off(a) <= 0.5 + span(toSolid(a))[X ? 0 : 1]).sort((a, b) => off(a) - off(b));
  for (const a of check) {
    const p0 = P(a), pa = { x: p0.x + dx, y: p0.y + dy, z: p0.z };
    const hit = (b) => stays(b) && collide(a, pa, b, P(b), hop) && !collide(a, p0, b, P(b), hop);
    if (near(solid, pa.x, pa.y, toSolid(a), hit) || (!isBelt(a) && near(belts, pa.x, pa.y, toBelt(a), hit))) return null;
  }
  // 剪切：一段挪了、别的没挪，供电覆盖和电塔连通得重新看
  if (range) {
    const reach = powerReach('tesla');
    const pos = (b) => (mark[b.index] & MOV ? [P(b).x + dx, P(b).y + dy] : [P(b).x, P(b).y]);
    const keep = S.live.filter((b) => !(mark[b.index] & GONE));
    const T = keep.filter((b) => b.itemId === TESLA).map(pos);
    const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    for (const b of keep) if (POWERED.includes(b.itemId)) { const q = pos(b); if (!T.some((t) => d2(t, q) <= reach.cover ** 2)) return null; }
    if (T.length > 1) {
      const seen = new Set([0]), st = [0];
      while (st.length) { const i = st.pop(); T.forEach((t, j) => { if (!seen.has(j) && d2(T[i], t) <= reach.link ** 2) { seen.add(j); st.push(j); } }); }
      if (seen.size < T.length) return null;
    }
  }
  return {
    links: links.length,
    moving: moving.length,
    apply() {
      for (const [b, a, n] of links) {
        a.outputObjIdx = n.index; // 带子接带子只记在上游那节
        a.outputToSlot = b.outputToSlot;
        S.removed.add(b.index);
      }
      for (const b of moving) for (const o of b.localOffset) { o.x += dx; o.y += dy; }
      refresh(S);
    },
  };
}
function tryLine(S, axis, c, side, range = null) {
  const line = lineAt(S, axis, c, range);
  return line && shift(S, line, side);
}

/** 删列：从左往右找能删的列，左边那侧朝站（右）挪，最左一列就挪右边；删到没有为止 */
function colPass(S) {
  for (let guard = 0; guard < 200; guard++) {
    const bb = bbox(S);
    let res = null;
    for (let c = bb.x0; c <= bb.x1 && !res; c++) {
      const line = lineAt(S, 'x', c);
      if (line) for (const side of [-1, 1]) {
        const r = shift(S, line, side);
        if (r && r.moving > 0) { res = r; break; }
      }
    }
    if (!res) break;
    res.apply();
  }
}

/** 删行（站那几行以外）：从外往里找，外侧朝站挪；删到没有为止 */
function rowPass(S) {
  for (let guard = 0; guard < 400; guard++) {
    const bb = bbox(S);
    const sy = RY(stationOf(S));
    let res = null;
    for (const [from, to, side] of [[bb.y1, sy + 4, 1], [bb.y0, sy - 4, -1]]) {
      for (let c = from; side > 0 ? c >= to : c <= to; c -= side) {
        const r = tryLine(S, 'y', c, side);
        if (r && r.moving > 0) { res = r; break; }
      }
      if (res) break;
    }
    if (!res) break;
    res.apply();
  }
}

/**
 * 站往循环那边剪切（只有一半有循环时）：以站左沿为界分成循环块和站块（站和它右边），谁在站外侧那头伸得更远，
 * 就在谁那一块里删一行（只删这一块的列），把它外侧那几行朝循环挪一格；一样远先收循环块，伸得远的那块挪不动就停
 */
function stationShear(S) {
  const st = stationOf(S);
  const sy = RY(st), k = RX(st) - 3;
  const up = S.live.some((b) => b.itemId === FRAC && RY(b) > sy), dn = S.live.some((b) => b.itemId === FRAC && RY(b) < sy);
  if (up && dn) return;
  const s = up ? -1 : 1; // 站外侧在哪头：上半边的阵列是 y 小的那头
  for (let guard = 0; guard < 100; guard++) {
    const bb = bbox(S);
    const ranges = [[bb.x0, k - 1], [k, bb.x1]];
    // 每块在站外侧那头的外沿（按中心在这一段里的建筑）
    const edges = ranges.map(([lo, hi]) => {
      const ys = S.live.filter((b) => RX(b) >= lo && RX(b) <= hi).map((b) => RY(b) + s * half(b));
      return s < 0 ? Math.min(...ys) : Math.max(...ys);
    });
    const out = (i) => s * (edges[i] - edges[1 - i]); // > 0：第 i 块伸得更远
    const i = out(0) > 0 ? 0 : out(1) > 0 ? 1 : 0;
    let res = null;
    for (let c = edges[i] - s; s < 0 ? c <= bb.y1 : c >= bb.y0; c -= s) {
      const r = tryLine(S, 'y', c, s, ranges[i]);
      if (r && r.moving > 0) { res = r; break; }
    }
    if (!res) break;
    res.apply();
  }
}

const reachT = () => powerReach('tesla');
const d2p = (a, b) => (P(a).x - P(b).x) ** 2 + (P(a).y - P(b).y) ** 2;
function connected(T, link) {
  if (T.length <= 1) return true;
  const seen = new Set([T[0]]), st = [T[0]];
  while (st.length) {
    const a = st.pop();
    for (const b of T) if (!seen.has(b) && d2p(a, b) <= link ** 2) { seen.add(b); st.push(b); }
  }
  return seen.size === T.length;
}
/** 删多余的电塔（覆盖、连通都还在就删），按 order 给的先后试 */
function pruneTeslas(S, order = (T) => T) {
  const { cover, link } = reachT();
  const need = S.live.filter((b) => POWERED.includes(b.itemId));
  let T = S.live.filter((b) => b.itemId === TESLA);
  for (const t of order(T)) {
    const rest = T.filter((u) => u !== t);
    if (need.every((n) => rest.some((u) => d2p(u, n) <= cover ** 2)) && connected(rest, link)) {
      T = rest;
      S.removed.add(t.index);
    }
  }
  refresh(S);
}
/** 删多余电塔：先试压着包围盒边的，再试离用电建筑重心远的 */
function prune(S) {
  const bb = bbox(S);
  const need = S.live.filter((b) => POWERED.includes(b.itemId));
  const cx = need.reduce((a, b) => a + P(b).x, 0) / need.length, cy = need.reduce((a, b) => a + P(b).y, 0) / need.length;
  const onEdge = (t) => RX(t) === bb.x0 || RX(t) === bb.x1 || RY(t) === bb.y0 || RY(t) === bb.y1;
  const far = (t) => (P(t).x - cx) ** 2 + (P(t).y - cy) ** 2;
  pruneTeslas(S, (T) => [...T].sort((a, b) => onEdge(b) - onEdge(a) || far(b) - far(a)));
}

/**
 * 电塔重放：全部拿掉，在「本来就删不掉的列 × 本来就删不掉的行」里的空格（头顶也没有高架、放下去不撞）上贪心重放：
 * 每次挑新覆盖最多的，同分挑离还没覆盖的重心近的；这样的格子盖不到了就退回任意不撞的空格（包围盒外 2 格以内也算）。
 * 再补连通的中继、删多余。放不下就把原来的电塔放回去、给 false
 */
function relocate(S) {
  const { cover, link } = reachT();
  const old = S.live.filter((b) => b.itemId === TESLA);
  if (!old.length) return false;
  const tpl = structuredClone(old[0]);
  for (const t of old) S.removed.add(t.index);
  refresh(S);
  const undo = () => { for (const t of old) S.removed.delete(t.index); refresh(S); return false; };
  const bb = bbox(S);
  const sy = RY(stationOf(S));
  const freeCol = new Set(), freeRow = new Set();
  for (let c = bb.x0; c <= bb.x1; c++) {
    const line = lineAt(S, 'x', c);
    if (line && [-1, 1].some((side) => shift(S, line, side))) freeCol.add(c);
  }
  for (let c = bb.y0; c <= bb.y1; c++) if (Math.abs(c - sy) > 3 && tryLine(S, 'y', c, c > sy ? 1 : -1)) freeRow.add(c);
  const L = S.live;
  const need = L.filter((b) => POWERED.includes(b.itemId));
  const cells = cellsOf(S);
  const fake = { itemId: TESLA, yaw: [0, 0], index: -1 };
  const [solid, belts] = blocksOf(S);
  const noHop = () => 99;
  const empty = [];
  for (let x = bb.x0 - 2; x <= bb.x1 + 2; x++) for (let y = bb.y0 - 2; y <= bb.y1 + 2; y++) {
    const hit = (b) => collide(fake, { x, y, z: 0 }, b, P(b), noHop);
    if (cells.has(K(x, y)) || near(solid, x, y, toSolid(fake), hit) || near(belts, x, y, toBelt(fake), hit)) continue;
    empty.push({ x, y, out: x < bb.x0 || x > bb.x1 || y < bb.y0 || y > bb.y1 });
  }
  const cand = empty.filter((c) => !c.out && !freeCol.has(c.x) && !freeRow.has(c.y));
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  // 每个空格盖得到哪几座用电建筑（位置不变，用到才算）
  const covOf = (c) => c.cov ?? (c.cov = need.flatMap((n, i) => (d2(c, P(n)) <= cover ** 2 ? [i] : [])));
  const placed = [];
  const covered = need.map(() => false);
  let left = need.length;
  // 离放好的电塔不到 3.5 m 的格子不能再放：每放一座标一次
  const ok = (c) => !c.near;
  const place = (p) => {
    placed.push(p);
    for (const c of empty) if (!c.near && (((p.x - c.x) * XS) ** 2 + (p.y - c.y) ** 2) * CELL_M ** 2 < TESLA_GAP2) c.near = true;
  };
  while (left > 0) {
    let gx = 0, gy = 0;
    need.forEach((n, i) => { if (!covered[i]) { gx += P(n).x; gy += P(n).y; } });
    gx /= left; gy /= left;
    const pool = cand.some((c) => ok(c) && covOf(c).some((i) => !covered[i])) ? cand : empty;
    let best = null, bs = 0, bd = Infinity;
    for (const c of pool) {
      if (!ok(c)) continue;
      let k = 0;
      for (const i of covOf(c)) if (!covered[i]) k++;
      const dd = (c.x - gx) ** 2 + (c.y - gy) ** 2;
      if (k > bs || (k === bs && k > 0 && dd < bd)) { bs = k; best = c; bd = dd; }
    }
    if (!best) return undo();
    place(best);
    for (const i of best.cov) if (!covered[i]) { covered[i] = true; left--; }
  }
  // 连通：两群之间补中继（先在候选格里挑，挑不到退回任意空格）
  const comps = () => {
    const out = [], seen = new Set();
    for (const p of placed) {
      if (seen.has(p)) continue;
      const g = [p];
      seen.add(p);
      for (let i = 0; i < g.length; i++) for (const q of placed) if (!seen.has(q) && d2(g[i], q) <= link ** 2) { seen.add(q); g.push(q); }
      out.push(g);
    }
    return out;
  };
  for (let g = 0; g < 20; g++) {
    const cs = comps();
    if (cs.length <= 1) break;
    const [a, ...rest] = cs;
    const b = rest.flat();
    const pick = (list) => list.find((c) => ok(c) && a.some((p) => d2(p, c) <= link ** 2) && b.some((p) => d2(p, c) <= link ** 2));
    const c = pick(cand) ?? pick(empty);
    if (!c) return undo();
    place(c);
  }
  if (comps().length > 1) return undo();
  for (const p of placed) {
    const t = structuredClone(tpl);
    t.index = S.all.length;
    for (const o of t.localOffset) { o.x = p.x; o.y = p.y; o.z = 0; }
    S.all.push(t);
    S.tags.set(t.index, 'T');
  }
  refresh(S);
  pruneTeslas(S);
  return true;
}

/** 存一份能改的东西（位置、带子往哪接、删了哪些、all 多长），试完不划算再放回去 */
function save(S) {
  return { n: S.all.length, removed: [...S.removed], b: S.all.map((b) => [b.localOffset.map((o) => [o.x, o.y]), b.outputObjIdx, b.outputToSlot]) };
}
function restore(S, s) {
  for (let i = s.n; i < S.all.length; i++) S.tags.delete(i);
  S.all.length = s.n;
  S.removed.clear();
  for (const i of s.removed) S.removed.add(i);
  s.b.forEach(([offs, out, slot], i) => {
    const b = S.all[i];
    offs.forEach(([x, y], k) => { b.localOffset[k].x = x; b.localOffset[k].y = y; });
    b.outputObjIdx = out;
    b.outputToSlot = slot;
  });
  refresh(S);
}

/** 压紧：all 里没在 removed 的就是留着的；直接改位置、链接、removed，新电塔追加到 all、标签记进 tags */
export function compact(all, removed, tags) {
  const S = { all, removed, tags, get: (i) => (i >= 0 && !removed.has(i) ? all[i] : null) };
  refresh(S);
  rowPass(S);
  prune(S);
  rowPass(S);
  stationShear(S);
  colPass(S);
  const snap = save(S);
  const b0 = bbox(S);
  if (relocate(S)) { colPass(S); rowPass(S); }
  const b1 = bbox(S);
  if (b1.w * b1.h >= b0.w * b0.h || b1.w > b0.w || b1.h > b0.h) restore(S, snap);
}
