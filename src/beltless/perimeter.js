// 无带流的带子区围着机器那一圈放：四条边顺时针 top 北、right 东、bottom 南、left 西。DSQ 排的带子区口在上头、往北接出去，
// 转过来让对面那条底边贴着机器的外框（隔 gap 格），口朝外；沿边从这条边的起点（顺时针方向）挪 offset 格。
// repack.js 照它放，页面拖带子区时照它算落在哪
export const SIDES = ['top', 'right', 'bottom', 'left'];
const EPS = 1e-6;

/** 顺时针转 k 个 90°（游戏坐标，y 朝北） */
export function turn(k, [x, y]) {
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [y, -x];
  return [x, y];
}

/** 带子区（原来的外框 z）放到机器外框 m 的 side 边上：转几个 90°（k）、转完以后的整数平移 tx、ty、放好的外框 box */
export function placeZone(z, m, side, offset = 0, gap = 1) {
  const k = SIDES.indexOf(side);
  const [a, b] = [turn(k, [z.x0, z.y0]), turn(k, [z.x1, z.y1])];
  const r = { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
  // 离机器那头至少 gap 格；沿边取最近的整格
  let tx, ty;
  if (side === 'top') [tx, ty] = [Math.round(m.x0 + offset - r.x0), Math.ceil(m.y1 + gap - r.y0 - EPS)];
  else if (side === 'right') [tx, ty] = [Math.ceil(m.x1 + gap - r.x0 - EPS), Math.round(m.y1 - offset - r.y1)];
  else if (side === 'bottom') [tx, ty] = [Math.round(m.x1 - offset - r.x1), Math.floor(m.y0 - gap - r.y1 + EPS)];
  else [tx, ty] = [Math.floor(m.x0 - gap - r.x1 + EPS), Math.round(m.y0 + offset - r.y0)];
  return { k, tx, ty, box: { x0: r.x0 + tx, x1: r.x1 + tx, y0: r.y0 + ty, y1: r.y1 + ty } };
}

/** 这条边上 offset 能取的范围：带子区比边短时整段贴在边上，比边长时盖住整条边 */
export function offsetRange(z, m, side) {
  const len = z.x1 - z.x0;
  const edge = side === 'top' || side === 'bottom' ? m.x1 - m.x0 : m.y1 - m.y0;
  return [Math.ceil(Math.min(0, edge - len) - EPS), Math.floor(Math.max(0, edge - len) + EPS)];
}

/** 离点 (cx, cy) 最近的放法（带子区中心尽量靠近它）：{ side, offset } */
export function nearestPlace(z, m, cx, cy, gap = 1) {
  const half = (z.x1 - z.x0) / 2;
  const want = { top: cx - m.x0 - half, right: m.y1 - cy - half, bottom: m.x1 - cx - half, left: cy - m.y0 - half };
  let best = null;
  for (const side of SIDES) {
    const [lo, hi] = offsetRange(z, m, side);
    const offset = Math.min(hi, Math.max(lo, Math.round(want[side])));
    const { box } = placeZone(z, m, side, offset, gap);
    const d = Math.hypot((box.x0 + box.x1) / 2 - cx, (box.y0 + box.y1) / 2 - cy);
    if (!best || d < best.d - 1e-9) best = { side, offset, d };
  }
  return { side: best.side, offset: best.offset };
}

/**
 * 有物流站时各块（站连它的带子、中间产物带）各自拖到哪都行，只要：不压机器的外框 m（隔一格）、块和块不重叠、站心两两隔够 span。
 * boxes：各块的外框；centers：站心 [x, y]（不是站的那块写 null）
 */
export function partsFit(boxes, centers, m, span) {
  const hit = (a, b, g) => a.x0 < b.x1 + g - EPS && b.x0 < a.x1 + g - EPS && a.y0 < b.y1 + g - EPS && b.y0 < a.y1 + g - EPS;
  for (let i = 0; i < boxes.length; i++) {
    if (hit(boxes[i], m, 1)) return false;
    for (let j = i + 1; j < boxes.length; j++) {
      if (hit(boxes[i], boxes[j], 0)) return false;
      if (centers[i] && centers[j] && Math.hypot(centers[i][0] - centers[j][0], centers[i][1] - centers[j][1]) < span - 1e-9) return false;
    }
  }
  return true;
}
