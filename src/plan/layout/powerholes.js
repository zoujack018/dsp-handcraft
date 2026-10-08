// 卫星配电站在行里的空位（待办 10，2026/10/08）
//
// 为什么：配电站 3×3，要九格全空、头顶没有高架带。行里同一块的工厂挨着排（制造台之间只有 1 格缝，熔炉、化工厂、研究站、
// 对撞机没有缝），块与块之间的空列（pad）最多 3 列、还常被竖着走的高架带占掉，行中间几乎放不下。搜索算供电时，附近没空地的工厂
// 只能靠外沿加一条地，离边远的够不着就按不可行罚，退火最省事的出路是把一两块挪进新的一行、整行空着放配电站——「配电站自成一行」：
// 多一行工厂、多一条通道；之后要同时挪好几处才回得去，退火走不回来。考卷 2026/10/08（各 2 个种子）：站+配电站比同样的线不供电
// 面积多 7%（考卷）~10%（放大 3 倍）。电力感应塔塞得进制造台之间的缝和通道里的空格，没有这个问题。
//
// 做法（route.js 调）：第一遍照原样排，估供电时有够不着的工厂/分拣器（power.js 的 powerBands 给的 lonely），才按第一遍真实的位置
// 给它们在行里挖空位，再排第二遍，两遍取代价低的。第一遍够得着的布局一字不变（行里本来放得下的中小产线，规划器在走带子之前
// 看不见通道里的空格，挖了反而多挪工厂，考卷上小线大 5%）。
// 挖法：从左往右扫还没覆盖的，在够得着它的各行里找最靠右的一个位置——行尾空地，或者两台工厂之间的缝，缝不够宽就把缝右边的工厂
// 往右挪，挪到够 3 格加上两边工厂要多隔的格数（gamedata.js 的 substationPad：化工厂左边 1、对撞机左 2 右 1、叠层研究站各 1）；
// 只用比最宽那行短的行，不把图撑宽（撑宽常常比另起一行还贵）。挑覆盖得多、挪得少、离它近的。
// 留好的空位这一行算「有工厂」，竖着走的高架带不从这里穿（layout/positions.js）；挖出来的那些供电时必放（power.js）。
import { substationPad, SUBSTATION_GAP } from '../../gamedata.js';
import { powerReach } from '../power.js';
import { STATION_COLS } from './shared.js';

/** 第二遍行的位置会有一点出入（通道宽窄跟着变），覆盖按半径少 1 格算 */
const MARGIN = 1;

/**
 * 按第一遍的布局 L 给够不着的挖空位。
 * @returns {{row: number, k: number, shift: number, x: number}[]} 按挖的先后：第 row 行第 k 台（行里按块的先后、块里按台数）起往右挪 shift 列，
 *   配电站中心最后落在第 x 列（占 x−1..x+1，纵向在这一行的中心）。positions.js 照这个先后挪
 */
export function powerHoles(L, opt) {
  const lonely = L.powerPlan?.lonely ?? [];
  const R = L.rows.length;
  if (!lonely.length || !R) return [];
  const { cover } = powerReach('substation', opt.powerOptions);
  const r2 = (cover - MARGIN) ** 2;
  const x0 = opt.station ? STATION_COLS : opt.leftMargin; // 生产区第一列
  // 每行的工厂按 x 从左到右（中心是本地的一份，挪动只改这里）。左右各要多隔几格按配电站对这种工厂的留格
  const F = L.rows.map((row) =>
    row.flatMap((bid) => {
      const p = L.pos.get(bid);
      const { pad } = substationPad(p.g);
      return p.centers.map((x) => ({ x, hw: (p.g.bodyWidth - 1) / 2, padL: pad.left, padR: pad.right }));
    }),
  );
  const ends = L.rows.map((row) => (row.length ? Math.max(...row.map((bid) => L.pos.get(bid).x1)) + 1 : x0)); // 每行右边第一列空列
  const limit = Math.min(Math.max(...ends), opt.maxWidth ? opt.maxWidth - 1 : Infinity);
  // 缝 k（第 k − 1 台和第 k 台之间；0 是行头，n 是行尾）：左边最后一格被占的列、右边第一格被占的列
  const lo = (h, k) => (k === 0 ? x0 - 1 : F[h][k - 1].x + F[h][k - 1].hw + F[h][k - 1].padR);
  const hi = (h, k) => (k === F[h].length ? Infinity : F[h][k].x - F[h][k].hw - F[h][k].padL);
  // 要覆盖的：够不着的工厂、分拣器（记下属于哪一行，挪工厂时跟着挪）
  const T = lonely.map((t) => ({ x: t.x, y: t.y, row: t.bid != null ? L.pos.get(t.bid)?.row ?? -1 : -1, covered: false, skip: false }));
  const plan = [];
  const used = L.rows.map(() => new Set());
  const covers = (s, t, dx = 0) => (t.x + dx - s.x) ** 2 + (t.y - L.rowCy[s.row]) ** 2 <= r2;
  const near = (h, x) => plan.some((s) => (s.x - x) ** 2 + (L.rowCy[s.row] - L.rowCy[h]) ** 2 < SUBSTATION_GAP ** 2);
  for (;;) {
    let t = null;
    for (const q of T) if (!q.covered && !q.skip && (!t || q.x < t.x)) t = q;
    if (!t) break;
    let best = null;
    for (let h = 0; h < R; h++) {
      const dy = L.rowCy[h] - t.y;
      if (dy * dy > r2) continue;
      const reach = Math.sqrt(r2 - dy * dy);
      const n = F[h].length;
      let k = -1;
      let x = NaN;
      // 行尾空地：不用挪工厂，挑够得着它的最靠右一格
      const l = lo(h, n);
      for (let xe = Math.min(Math.floor(t.x + reach), limit - 2); xe >= l + 2 && xe >= t.x - reach; xe--)
        if (!near(h, xe)) {
          k = n;
          x = xe;
          break;
        }
      // 够不着就找行里的缝：空位中心 lo + 2 随 k 单调不减，找最靠右、够得着、没用过、和别的空位隔够的
      if (k < 0) {
        let j = n - 1;
        while (j >= 0 && lo(h, j) + 2 > t.x + reach) j--;
        for (; j >= 0 && lo(h, j) + 2 >= t.x - reach; j--)
          if (!used[h].has(j) && !near(h, lo(h, j) + 2)) {
            k = j;
            x = lo(h, j) + 2;
            break;
          }
      }
      if (k < 0) continue;
      const shift = k === n ? 0 : Math.max(0, lo(h, k) + 4 - hi(h, k));
      const end = k === n ? Math.max(ends[h], x + 2) : ends[h] + shift;
      if (end > limit) continue;
      // 新覆盖几个（这一行缝右边的挪过以后再算）
      const at = lo(h, k);
      const s = { row: h, x };
      let gain = 0;
      for (const q of T) if (!q.covered && covers(s, q, q.row === h && q.x > at ? shift : 0)) gain++;
      if (!gain) continue;
      if (!best || gain > best.gain || (gain === best.gain && (shift < best.shift || (shift === best.shift && Math.abs(dy) < Math.abs(best.dy))))) best = { h, k, x, shift, end, gain, dy };
    }
    if (!best) {
      t.skip = true; // 够得着它的行都没有余量：留给搜索（外沿加地、腾出行尾）
      continue;
    }
    const { h, k, shift } = best;
    if (shift > 0) {
      // 缝右边的工厂往右挪，连同这一行要覆盖的、已经留好的空位
      const at = lo(h, k);
      for (let j = k; j < F[h].length; j++) F[h][j].x += shift;
      for (const q of T) if (q.row === h && q.x > at) q.x += shift;
      for (const s of plan) if (s.row === h && s.x > at) s.x += shift;
    }
    plan.push({ row: h, k, shift, x: best.x });
    used[h].add(k);
    ends[h] = best.end;
    for (const q of T) q.covered = plan.some((s) => covers(s, q));
  }
  return plan;
}
