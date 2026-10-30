// 精确楼层切片：L1 对应 z=0；沿导出的逐格路径拆分，不按整段最高层猜测。
export const COLORS = ['#ffd166', '#f4978e', '#7fd1ae', '#9ad0f5', '#e8b4f8', '#c5e17a', '#ffb877', '#8ee3e0', '#f7a6c3', '#d9c3ff', '#b8f2a1', '#ffe3a3'];
const INK = '#e6f0ff';
const PAPER = '#112f52';
// 建筑按蓝图的画法：蓝底白线，不填色块。粗线是机器轮廓，细线是机壳、炉口、罐体；
// 轮廓就是规规矩矩的长方形（不出头），轮廓里面沿右边和下边排一道 45° 斜线的「手打阴影」，两头 45° 收口，
// 像制图员用三角板一笔笔排出来的；阴影不出轮廓，图面干净。
export const LINE = '#eef5ff'; // 轮廓（粗）
export const FINE = '#a9c4e0'; // 机壳、中心标记（细）
const FAINT = '#6f90b3'; // 管道等次要线
const HEAVY = 0.085;
const MED = 0.05;
const THIN = 0.03;
const ARM = '#dbe8f7'; // 分拣器
const POWER = '#ffd666'; // 供电设施（旧版的黄色）
// 选中一条线时，其他物品统一画成这一种灰蓝（不用半透明，免得黄色和底色混成橄榄色）
const DIM = '#3d5f84';
const SANS = '"DIN Alternate", "Bahnschrift", "PingFang SC", "Microsoft YaHei", sans-serif';
// 平面图里方形机器画多大（格）：熔炉、制造台按碰撞体，研究站碰撞体 4.5 格，略收一点
const FOOT = { smelter: 2.4, assembler: 3.2, lab: 4.3, fractionator: 2.4 };
/** 平面图里机器的框：方形机器按 FOOT；化工厂按碰撞体 7 格宽、上方比下方多占一行（框中心往上挪半格）；对撞机按碰撞体 9×5 略收 */
export function footprint(g) {
  if (g.kind === 'chemical') return { w: (g.w ?? 8) - 0.4, h: (g.below ?? 1) + (g.above ?? 1) + 0.4, dy: ((g.above ?? 1) - (g.below ?? 1)) / 2 };
  if (g.kind === 'collider') return { w: (g.w ?? 10) - 0.4, h: (g.h ?? 5) - 0.4, dy: ((g.above ?? 2) - (g.below ?? 2)) / 2 };
  if (g.kind === 'refinery') return { w: (g.w ?? 2.8) - 0.2, h: (g.h ?? 5.4) - 0.2, dy: g.shift?.[1] ?? 0 }; // 原油精炼厂：长条，往南偏（gamedata.js）
  const s = FOOT[g.kind] ?? 3;
  return { w: s, h: s, dy: 0 };
}
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const routeColor = (model, id) => COLORS[Object.keys(model.items).indexOf(String(id)) % COLORS.length] || INK;

/** 楼层按 z 分（取到 1e-3）：半层的带（z = 0.5、1.5…，docs/game-rules.md 第 38 条）单独一层 */
const zKey = (z) => Math.round((z ?? 0) * 1000) / 1000;

/**
 * 按 z 从小到大排的楼层：整数层 0..max(2, 最高层) 都有（空的也给），半层只在有格子时才有。
 * 坡（相邻两格位置不同、高度不同）不记升降点，连着的那一小段归高的那边：往上走时新的那段记 from（上一格），往下走时离开的那段记 to（下一格）；
 * 同一格里高度变了（原地升降、原地升半层）照旧记升降点 vias
 */
export function sliceRoutes(routes) {
  const levels = new Map();
  const ensure = (z) => {
    if (!levels.has(z)) levels.set(z, { z, runs: [], vias: [], items: new Set(), cells: new Set() });
    return levels.get(z);
  };
  for (const { itemId, cells } of routes) {
    let run = null;
    const viaKeys = new Set();
    for (let i = 0; i < cells.length; i++) {
      const [x, y] = cells[i];
      const z = zKey(cells[i][2]);
      const floor = ensure(z);
      floor.items.add(String(itemId));
      floor.cells.add(`${x},${y}`);
      const prev = cells[i - 1];
      const pz = prev ? zKey(prev[2]) : z; // 上一格的高度
      const slope = pz !== z && (prev[0] !== x || prev[1] !== y); // 坡：换了格又换了高度
      if (!run || run.z !== z) {
        if (slope && z < pz) run.to = [x, y]; // 往下走：坡那一小段归离开的那段
        // prev：同一条带换层之前的那一段（在别的层；带头那段是 null），单层图据此找别层接着走的那几段（linkedRuns）；往上走：坡那一小段归新的这段
        run = { z, itemId, cells: [], prev: run, ...(slope && z > pz ? { from: [prev[0], prev[1]] } : {}) };
        floor.runs.push(run);
      }
      if (!run.cells.length || run.cells.at(-1)[0] !== x || run.cells.at(-1)[1] !== y) run.cells.push([x, y, z]);
      if (pz !== z && !slope) {
        // 同一格里换了高度：升降节点在两层都标出；中间层只画节点，不把不相连的线拼起来。
        for (const [level, to] of [[pz, z], [z, pz]]) {
          const key = `${x},${y},${level},${to}`;
          if (viaKeys.has(key)) continue;
          viaKeys.add(key);
          ensure(level).vias.push({ x, y, itemId, to, direction: Math.sign(z - pz) });
        }
      }
    }
  }
  const top = Math.max(2, ...[...levels.keys()].map(Math.floor));
  for (let z = 0; z <= top; z++) ensure(z);
  return [...levels.values()].filter((f) => Number.isInteger(f.z) || f.cells.size).sort((a, b) => a.z - b.z);
}

/** 一段带画成折线的点：坡上接过来的那一格（from）、本层的格、坡下去的那一格（to），没有的不放 */
export const runPoints = (run) => [...(run.from ? [run.from] : []), ...run.cells, ...(run.to ? [run.to] : [])];

/**
 * 单看第 level 层时，本层的带在升降点前后接着走的别层那几段：本层每段往前、往后各找一段。
 * 竖着穿过某层的那一格（只有一格、前后都接着别的层）不算那层的带：往外找时跳过去接着找，本层的这种格也不往外找，
 * 免得看 L2 时把从 L2 穿过去的 L3、L4 整层都带出来。坡上只占一格的那几段（带 from / to）跳过去时也带上，虚线才连得上
 */
export function linkedRuns(floors, level) {
  const next = new Map(); // 每段 → 同一条带的下一段
  for (const f of floors) for (const r of f.runs) if (r.prev) next.set(r.prev, r);
  const out = new Set();
  for (const f of floors) {
    if (f.z !== level) continue;
    for (const run of f.runs) {
      if (run.cells.length === 1 && run.prev && next.has(run)) continue;
      for (const step of [(r) => r.prev, (r) => next.get(r)]) {
        for (let r = step(run); r && r.z !== level; r = step(r)) {
          if (r.cells.length > 1) {
            out.add(r);
            break;
          }
          if (r.from || r.to) out.add(r);
        }
      }
    }
  }
  return [...out];
}

const F3 = (n) => +n.toFixed(3);
const seg = (x1, y1, x2, y2, c, w, extra = '') => `<path d="M${F3(x1)} ${F3(y1)}L${F3(x2)} ${F3(y2)}" stroke="${c}" stroke-width="${w}" fill="none"${extra}/>`;
const ring = (x, y, r, c, w, fill = 'none') => `<circle cx="${F3(x)}" cy="${F3(y)}" r="${F3(r)}" fill="${fill}" stroke="${c}" stroke-width="${w}"/>`;
const rectD = (x0, y0, x1, y1) => `M${F3(x0)} ${F3(y0)}H${F3(x1)}V${F3(y1)}H${F3(x0)}Z`;
/** 手打阴影（画在轮廓里面）：沿右边和下边内侧一道宽 t 的斜线带，两头 45° 收口 */
const innerShade = (x0, y0, x1, y1, t, hatch) => `<path d="M${F3(x1)} ${F3(y0)}V${F3(y1)}H${F3(x0)}L${F3(x0 + t)} ${F3(y1 - t)}H${F3(x1 - t)}V${F3(y0 + t)}Z" fill="url(#${hatch})"/>`;
/** 物流站八角形的内侧阴影：右边、右下斜边、下边三段往里收 t，两头 45° 收口（a 半边长 3.4，b 斜角处 2.6） */
const stationShade = (x, y, t, hatch, a = 3.4, b = 2.6) => {
  const m = a + b - t * Math.SQRT2; // 斜边往里收 t 以后：u + v = m
  const P = [[a, -b], [a, b], [b, a], [-b, a], [-b + t, a - t], [m - (a - t), a - t], [a - t, m - (a - t)], [a - t, -b + t]];
  return `<path d="M${P.map(([u, v]) => `${F3(x + u)} ${F3(y + v)}`).join('L')}Z" fill="url(#${hatch})"/>`;
};

/**
 * 工厂平面图（白线 + 轮廓内的手打阴影）：
 *   制造台：方形轮廓 + 内收一圈的细线机壳
 *   熔炉：方形轮廓 + 圆形炉口
 *   化工厂（用户 2026-10-04 选的方案四，球罐按方案一）：左边横放的短筒（两端圆头），中间机箱写字母，
 *     右边大玻璃球罐（圆 + 左上一道高光弧）
 *   研究站：方形底座 + 玻璃穹顶（两道圆）+ 四角立柱，两道圆之间写这一叠有几层；叠得越高，阴影越宽
 *   粒子对撞机：长方形底座 + 环形加速器（两道同心圆）+ 中间对撞室（小方块），分拣器接口偏在左边
 *   分馏塔：方底座 + 圆塔身，一个小三角指向侧面的产物口（重氢从这边出来），塔身里写它属于哪个氢循环
 * letter 是这组的标号，num 是这一台是第几台（用户 2026/10/27）。制造台、对撞机这类地方大的写成一行 A 12：字母和编号同大同色同粗细，
 * 中间留 0.12 个字宽的细空（比普通空格 0.25~0.28 小一半，介于印刷里的发丝空格和细空格之间：看得出分开、又不散），按大写字母高度垂直居中；
 * 字号按这种设备放得下来定，同一种设备一样大（试过字母粗亮编号细淡同基线、仪表位号那样上下叠，用户都不要）。
 * 熔炉（小写字母 a、b、c…）、分馏塔圆圈里挤，字母照常居中，数字挪到右下角压着圆、描一圈底色。
 * hidden（这一层已经高过机器）按看不见的轮廓画成虚线，不画阴影。mini（楼层缩略图）只画轮廓。
 */
function factoryShape(kind, cx, cy, w, h, o) {
  const { letter: mark, num, mini, text, tag, hidden, hatch, levels = 1 } = o;
  const letter = mark;
  // 标号写在宽 room 的地方：字号不超过 size；按「字母 + 细空 + 两位数」估宽：0.62 + 0.12 + 2 × 0.55 ≈ 1.9 个字号
  const label = (x, y, size, room) => tag(x, y, mark, num, F3(Math.min(size, room / 1.9)));
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
  const d = rectD(x0, y0, x1, y1);
  if (mini) return `<path d="${d}" fill="${PAPER}" stroke="${FINE}" stroke-width="0.22"/>`;
  if (hidden) return `<path d="${d}" fill="none" stroke="${FAINT}" stroke-width="${MED}" stroke-dasharray="0.3 0.18"/>`;
  const t = kind === 'lab' ? Math.min(0.55, 0.28 + 0.04 * (levels - 1)) : kind === 'smelter' ? 0.24 : 0.3;
  let s = `<path d="${d}" fill="${PAPER}"/>` + innerShade(x0, y0, x1, y1, t, hatch) + `<path d="${d}" fill="none" stroke="${LINE}" stroke-width="${HEAVY}" stroke-linejoin="miter"/>`;
  if (kind === 'chemical') {
    // 右边大球罐：圆 + 左上一道高光弧
    const r = Math.min(h * 0.36, w * 0.16);
    const sx = x1 - 0.42 - r;
    s += ring(sx, cy, r, FINE, MED, PAPER) + `<path d="M${F3(sx - r * 0.62)} ${F3(cy - r * 0.25)}A${F3(r * 0.7)} ${F3(r * 0.7)} 0 0 1 ${F3(sx - r * 0.15)} ${F3(cy - r * 0.68)}" fill="none" stroke="${FINE}" stroke-width="${THIN}"/>`;
    // 左边横放的短筒：两端圆头
    const th = Math.min(1.0, h * 0.3), tx0 = x0 + 0.4, tx1 = x0 + Math.min(2.0, w * 0.27);
    s += `<path d="M${F3(tx0 + th / 2)} ${F3(cy - th / 2)}H${F3(tx1 - th / 2)}A${F3(th / 2)} ${F3(th / 2)} 0 0 1 ${F3(tx1 - th / 2)} ${F3(cy + th / 2)}H${F3(tx0 + th / 2)}A${F3(th / 2)} ${F3(th / 2)} 0 0 1 ${F3(tx0 + th / 2)} ${F3(cy - th / 2)}Z" fill="none" stroke="${FINE}" stroke-width="${MED}"/>`;
    // 中间机箱
    const hx0 = tx1 + 0.35, hx1 = sx - r - 0.35;
    s += `<path d="${rectD(hx0, y0 + 0.45, hx1, y1 - 0.45)}" fill="none" stroke="${FINE}" stroke-width="${THIN}"/>`;
    return s + (letter ? label((hx0 + hx1) / 2, cy, 0.95, hx1 - hx0 - 0.2) : '');
  }
  if (kind === 'collider') {
    // 环形加速器偏右（分拣器接口在左边，字母写在左边）
    const r = Math.min(h * 0.4, w * 0.2);
    const rx = x1 - 0.45 - r;
    s += ring(rx, cy, r, FINE, MED, PAPER) + ring(rx, cy, r * 0.68, FINE, THIN) + `<path d="${rectD(rx - 0.32, cy - 0.32, rx + 0.32, cy + 0.32)}" fill="none" stroke="${FINE}" stroke-width="${THIN}"/>`;
    const lx = (x0 + rx - r) / 2;
    s += seg(rx - r - 0.35, y0 + 0.5, rx - r - 0.35, y1 - 0.5, FINE, THIN);
    return s + (letter ? label(lx, cy, 1.05, rx - r - 0.35 - x0 - 0.3) : '');
  }
  if (kind === 'fractionator') {
    const dir = (o.yaw ?? 90) > 180 ? -1 : 1; // 朝右（yaw 90）的塔产物口在右边，朝左（yaw 270）的在左边
    s += ring(cx, cy, w * 0.33, FINE, MED, PAPER) + `<path d="M${F3(cx + dir * w * 0.36)} ${F3(cy - 0.2)}L${F3(cx + dir * (w * 0.5 - 0.12))} ${F3(cy)}L${F3(cx + dir * w * 0.36)} ${F3(cy + 0.2)}Z" fill="${FINE}"/>`;
    return s + (mark ? text(cx, cy, mark, 0.62, LINE, 500) + corner(cx, cy, w * 0.33, num, text) : '');
  }
  if (kind === 'thermal') {
    const r = Math.min(h * 0.28, 0.9);
    s += ring(x1 - 0.5 - r, cy, r, FINE, MED, PAPER) + ring(x1 - 0.5 - r, cy, r * 0.55, FINE, THIN);
    return s + (letter ? text(x0 + (w - 2 * r - 0.5) / 2, cy, letter, 0.95, LINE, 500) : '');
  }
  if (kind === 'smelter') {
    s += ring(cx, cy, w * 0.31, FINE, MED);
    // 小写字母（熔炉的标号）字号放大到 0.92、按 x 高度（约 0.52 个字号）垂直居中，基线在中心下 0.26 个字号；储液罐的「罐」照旧居中
    const small = /^[a-z]$/.test(mark ?? '');
    return s + (mark ? (small ? tag(cx, cy - 0.09 * 0.92, mark, null, 0.92) : text(cx, cy, mark, 0.78, LINE, 500)) + corner(cx, cy, w * 0.31, num, text) : '');
  }
  if (kind === 'lab') {
    const k = 0.36;
    s += ring(cx, cy, w * 0.36, FINE, MED) + ring(cx, cy, w * 0.25, FINE, THIN);
    for (const [px, py] of [[x0 + 0.14, y0 + 0.14], [x1 - 0.14 - k, y0 + 0.14], [x0 + 0.14, y1 - 0.14 - k], [x1 - 0.14 - k, y1 - 0.14 - k]]) s += `<path d="${rectD(px, py, px + k, py + k)}" fill="${PAPER}" stroke="${FINE}" stroke-width="${THIN}"/>`;
    return s + (letter ? label(cx, cy, 1.05, w * 0.5 - 0.1) : '') + (levels > 1 ? text(cx, cy + w * 0.305, `×${levels}`, 0.42, FINE, 500) : '');
  }
  const k = 0.42;
  s += `<path d="${rectD(x0 + k, y0 + k, x1 - k, y1 - k)}" fill="none" stroke="${FINE}" stroke-width="${THIN}"/>`;
  return s + (letter ? label(cx, cy, 1.0, w - 2 * k - 0.2) : '');
}
/** 熔炉、分馏塔的编号：圆（半径 r）右下角外面一点，压着圆，描一圈底色免得和圆线混在一起 */
const corner = (cx, cy, r, num, text) => (num ? text(F3(cx + r * 0.82), F3(cy + r * 0.78), num, 0.46, LINE, 600, ` stroke="${PAPER}" stroke-width="0.14" paint-order="stroke" stroke-linejoin="round"`) : '');

// icon(物品编号)：原料入口旁边画的物品图标，返回以 (0, 0) 为中心、0.8 格见方的 SVG 标记（或 null）；页面给，不给就不画
export function drawingSvg(model, floors, { level = 0, focus = '', selected = '', buildings = true, sorters = true, power = false, mini = false, id = 'main', label = '产线布线图', icon = null } = {}) {
  const W = model.width, H = model.height;
  // 竖排（model.rotated）：图在横排的坐标里画，最后整组顺时针转 90° 显示（和出出来的蓝图一致），字再各自转回来摆正
  const rot = !!model.rotated;
  const DW = rot ? H : W, DH = rot ? W : H;
  let spin = rot ? 90 : 0;
  const ox = model.origin?.x ?? 0, oy = model.origin?.y ?? 0;
  const X = (x) => x + ox + 0.5;
  const Y = (y) => H - y - oy - 0.5;
  const all = level === 'all';
  const shown = all ? floors : floors.filter((f) => f.z === level);
  const parts = [];
  const hits = [];
  const title = (s) => mini ? '' : `<title>${escape(s)}</title>`;
  const dim = (itemId) => !!focus && String(itemId) !== focus;
  const attrs = (itemId) => `data-route-item="${itemId}"`;
  // 选中某个物品时：它保持原色，其他物品统一成灰蓝
  const tint = (itemId, c) => (dim(itemId) ? DIM : c);
  // 设备标号：A 12 一行，同大同色同粗细，字母和编号之间 0.12 个字宽的细空；按大写字母高度（约 0.7 个字号）垂直居中，所以基线在中心下 0.35 个字号
  const tag = (x, y, letter, num, size) =>
    `<text x="${x}" y="${F3(y + size * 0.35)}" fill="${LINE}" font-size="${size}" font-family='${SANS}' font-weight="500" text-anchor="middle"${spin ? ` transform="rotate(${-spin} ${x} ${y})"` : ''}>${escape(letter)}${num ? `<tspan dx="${F3(size * 0.12)}">${num}</tspan>` : ''}</text>`;
  // extra：另加的属性（熔炉编号描底色的那圈）
  const text = (x, y, value, size = 0.8, color = INK, weight = 400, extra = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-family='${SANS}' font-weight="${weight}" text-anchor="middle" dominant-baseline="central"${extra}${spin ? ` transform="rotate(${-spin} ${x} ${y})"` : ''}>${escape(value)}</text>`;
  parts.push(`<defs><pattern id="${id}-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#1b3d60" stroke-width="0.035"/></pattern><pattern id="${id}-major" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="url(#${id}-grid)"/><path d="M5 0H0V5" fill="none" stroke="#294c70" stroke-width="0.055"/></pattern><pattern id="${id}-hatch" width="0.2" height="0.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0.1 0V0.2" stroke="${FINE}" stroke-width="0.03"/></pattern></defs>`);
  const hatch = `${id}-hatch`;
  const c0 = parts.length; // 从这里起是布局本身（竖排时整组转 90°）
  parts.push(`<rect width="${W}" height="${H}" fill="${PAPER}"/>`);
  if (!mini) parts.push(`<rect width="${W}" height="${H}" fill="url(#${id}-major)"/>`);
  // 每台工厂是同一个标号里的第几台（用户 2026/10/27：A1、A2…）：按看图的顺序数，从上往下一行行、每行从左往右。
  // 竖排（现在只有分馏阵列）整张顺时针转了 90°：屏幕上的上下是原来的 x、左右是原来的 y
  const nth = new Map(); // 组 → 各台的序号（和 centers 一一对应）
  {
    const all = [];
    for (const row of model.rows) for (const g of row.groups) if (g.letter && !g.store) g.centers.forEach((cx, i) => all.push({ g, i, cy: row.cy, cx }));
    all.sort((a, b) => (rot ? a.cx - b.cx || a.cy - b.cy : b.cy - a.cy || a.cx - b.cx));
    const count = new Map();
    for (const { g, i } of all) {
      const k = (count.get(g.letter) ?? 0) + 1;
      count.set(g.letter, k);
      (nth.get(g) || nth.set(g, []).get(g))[i] = k;
    }
  }
  if (buildings) {
    for (const [ri, row] of model.rows.entries()) for (const [gi, g] of row.groups.entries()) {
      const { w, h, dy } = footprint(g);
      for (const [i, cx] of g.centers.entries()) {
        const x = X(cx), y = Y(row.cy + dy);
        // 工厂约三层高（研究站每层 3 格高，叠几层就高几倍）：高过机器的楼层只剩一个虚线占地
        const levels = g.levels ?? 1;
        // 排进行里的储物仓（箱子供货）：和外面那种一样写「仓」（顶上放了配送器写「配」，储液罐写「罐」），一叠多高按层数 × 每层抬多高
        const st = g.store;
        const above = !all && level >= (st ? Math.ceil(levels * (g.levelZ ?? 2)) : g.kind === 'lab' ? 3 * levels : 3);
        const num = nth.get(g)?.[i];
        const no = num ? ` · 编号 ${g.letter}${num}` : '';
        const hint = st ? `${g.factory}${st.dist ? ' + 物流配送器' : ''} · ${st.kind === 'in' ? '原料' : '成品'} ${g.item} · 叠 ${levels} 层` : g.kind === 'lab' ? `${g.item}${no} · ${g.factory} · 每叠 ${levels} 层` : `${g.item}${no} · ${g.factory} · 约三层体量示意`;
        // 单击工厂开小窗（app.js 的 renderMachine）：data-machine 是 行:组:第几台；储物仓照旧在线路简介框里写介绍
        parts.push(`<g class="factory"${g.recipe ? ` data-machine="${ri}:${gi}:${i}"` : ''}>${title(hint)}${factoryShape(g.kind, x, y, w, h, { letter: st ? (st.tank ? '罐' : st.dist ? '配' : '仓') : g.letter, num, mini, text, tag, hidden: above, hatch, levels, yaw: g.yaw })}</g>`);
      }
    }
    // 就地烧副产物的火力发电厂（朝东摆，碰撞体按估计画）：方框 + 右上一个烟囱圈，框里写「火」
    for (const b of model.burners || []) for (const [px, py] of b.plants) {
      const x = X(px + b.box.dx), y = Y(py + b.box.dy), w = b.box.w - 0.3, h = b.box.h - 0.3;
      const above = !all && level >= 3;
      parts.push(`<g class="factory">${title(`火力发电厂 · 烧多余的${model.items[100000 + b.itemId]?.name ?? model.items[b.itemId]?.name ?? ''}`)}${factoryShape('thermal', x, y, w, h, { letter: '火', mini, text, tag, hidden: above, hatch })}</g>`);
    }
    // 箱子供货的储物仓、储液罐（plan/storage.js）：仓画成方框写「仓」（顶上放了物流配送器的写「配」），储液罐画成圆写「罐」
    for (const s of model.stores || []) {
      const [bw, bh] = { 2101: [2.4, 2.4], 2102: [4.4, 2.4], 2106: [3.5, 3.5] }[s.type] ?? [2.4, 2.4];
      const what = s.type === 2106 ? '储液罐' : s.type === 2101 ? '小型储物仓' : '大型储物仓';
      const hint = `${what}${s.dist ? ' + 物流配送器' : ''} · ${s.kind === 'in' ? '原料' : '成品'} ${model.items[s.itemId]?.name ?? model.items[100000 + s.itemId]?.name ?? ''} · 叠 ${s.layers} 层`;
      for (const [px, py] of s.tank ? [[s.tank.x, s.tank.y]] : s.boxes) {
        parts.push(`<g class="factory">${title(hint)}${factoryShape(s.tank ? 'smelter' : 'store', X(px), Y(py), bw - 0.3, bh - 0.3, { letter: s.tank ? '罐' : s.dist ? '配' : '仓', mini, text, tag, hidden: !all && level >= 3, hatch })}</g>`);
      }
    }
    (model.stations || []).forEach((st, k) => {
      const x = X(st.x), y = Y(st.y);
      // 物流站：粗线八角轮廓 + 两道细线圆 + 圆上的四个中心标记，T1 字样保留
      const o = `M${x - 2.6} ${y - 3.4}H${x + 2.6}L${x + 3.4} ${y - 2.6}V${y + 2.6}L${x + 2.6} ${y + 3.4}H${x - 2.6}L${x - 3.4} ${y + 2.6}V${y - 2.6}Z`;
      const marks = `<path d="M${x} ${y - 2.65}v0.7M${x} ${y + 1.95}v0.7M${x - 2.65} ${y}h0.7M${x + 1.95} ${y}h0.7" stroke="${FINE}" stroke-width="${THIN}"/>`;
      parts.push(`<g class="station" data-station="${k}">${title(`物流塔 ${k + 1} · 点一下看站口、存储，可以改供需和上限`)}<path d="${o}" fill="${PAPER}"/>${mini ? '' : stationShade(x, y, 0.45, hatch)}<path d="${o}" fill="none" stroke="${mini ? FINE : LINE}" stroke-width="${mini ? 0.25 : HEAVY}"/>${mini ? '' : `${ring(x, y, 2.3, FINE, MED)}${ring(x, y, 1.55, FINE, THIN)}${marks}${text(x, y, `T${k + 1}`, 1.05, LINE, 500)}`}</g>`);
    });
  }
  if (buildings) for (const st of model.stationSites || []) {
    // 搜索中预留的物流站位置（打分时估的空地，搜索结束后才真正接站）：虚线八角轮廓
    const x = X(st.x), y = Y(st.y);
    const o = `M${x - 2.6} ${y - 3.4}H${x + 2.6}L${x + 3.4} ${y - 2.6}V${y + 2.6}L${x + 2.6} ${y + 3.4}H${x - 2.6}L${x - 3.4} ${y + 2.6}V${y - 2.6}Z`;
    parts.push(`<g class="station-site">${title('预留的物流站位置：搜索时按这里留空地，搜索结束后再真正接站，位置可能会变')}<path d="${o}" fill="none" stroke="${FINE}" stroke-width="${mini ? 0.2 : HEAVY}" stroke-dasharray="0.6 0.45"/>${mini ? '' : text(x, y, '站', 1.05, FINE, 500)}</g>`);
  }
  if (!mini && power && model.power) for (const n of model.power.nodes) parts.push(`<circle cx="${X(n.x)}" cy="${Y(n.y)}" r="${model.power.cover}" fill="rgba(255,214,102,0.035)" stroke="rgba(255,214,102,0.22)" stroke-width="0.06" stroke-dasharray="0.4 0.3"/>`);
  // 工厂的轮廓框（格坐标，y 向上），分拣器的转轴画在轮廓线上
  const boxes = [];
  for (const row of model.rows) for (const g of row.groups) {
    const { w, h, dy } = footprint(g);
    for (const cx of g.centers) boxes.push({ x0: cx - w / 2, x1: cx + w / 2, y0: row.cy + dy - h / 2, y1: row.cy + dy + h / 2 });
  }
  const pivotY = (so) => {
    const b = boxes.find((q) => so.x >= q.x0 - 0.01 && so.x <= q.x1 + 0.01 && so.y0 >= q.y0 - 0.5 && so.y0 <= q.y1 + 0.5);
    return b ? (so.y1 > so.y0 ? b.y1 : b.y0) : so.y0;
  };
  // 分拣器压在地面的带子上面、高架的带子下面（用户：传送带在下面，分拣器在上面，上面还有东西就依次显示）：先画好，画完地面那层再放进去
  const sorterParts = [];
  if (!mini && (all || level === 0) && sorters) for (const so of model.sorters) {
    // 分拣器（机械臂的平面符号）：工厂一端一个空心转轴圈，一根臂伸到所接那格带子的中心，那里一个实心圆点是爪（压在带子上）；
    // 臂中间一个开口箭头指向搬运方向（取料朝工厂，出料朝带子）。平时浅色线，选中某个物品时接它的分拣器变成它的颜色
    const on = focus && String(so.itemId) === focus;
    const c = on ? routeColor(model, so.itemId) : dim(so.itemId) ? DIM : ARM;
    if (so.x1 != null) {
      // 横着的（研究站夹带的侧面分拣器，x1 是带子那一列）：转轴圈画在工厂轮廓的左边或右边上，臂横着伸到带子那格
      const b = buildings ? boxes.find((q) => so.x >= q.x0 - 0.5 && so.x <= q.x1 + 0.5 && so.y0 >= q.y0 - 0.01 && so.y0 <= q.y1 + 0.01) : null;
      const xf = X(b ? (so.x1 > so.x ? b.x1 : b.x0) : so.x), xb = X(so.x1), y = Y(so.y0);
      const d = Math.sign(xb - xf) || 1;
      const k = so.io === 'out' ? d : -d; // 箭头朝搬的方向
      const mid = xb - d * 0.5;
      const arrow = Math.abs(xb - xf) > 0.62 ? `<path d="M${F3(mid - 0.08 * k)} ${F3(y - 0.13)}L${F3(mid + 0.06 * k)} ${F3(y)}L${F3(mid - 0.08 * k)} ${F3(y + 0.13)}" fill="none" stroke="${c}" stroke-width="${THIN * 1.4}"/>` : '';
      sorterParts.push(`<g ${attrs(so.itemId)}>${seg(xf + d * 0.12, y, xb, y, c, 0.06)}${ring(xf, y, 0.12, c, MED, PAPER)}<circle cx="${F3(xb)}" cy="${F3(y)}" r="0.11" fill="${c}"/>${arrow}</g>`);
      continue;
    }
    const x = X(so.x), yf = Y(buildings ? pivotY(so) : so.y0), yb = Y(so.y1);
    const d = Math.sign(yb - yf) || 1;
    const from = so.io === 'out' ? yf : yb, to = so.io === 'out' ? yb : yf;
    const k = Math.sign(to - from) || 1;
    // 箭头放在所接那条带前面半格的空当里（两条轨道之间、不被带子压住）；臂太短（1 格长、贴着工厂）就不画
    const mid = yb - d * 0.5;
    const arrow = Math.abs(yb - yf) > 0.62 ? `<path d="M${F3(x - 0.13)} ${F3(mid - 0.08 * k)}L${F3(x)} ${F3(mid + 0.06 * k)}L${F3(x + 0.13)} ${F3(mid - 0.08 * k)}" fill="none" stroke="${c}" stroke-width="${THIN * 1.4}"/>` : '';
    sorterParts.push(`<g ${attrs(so.itemId)}>${seg(x, yf + d * 0.12, x, yb, c, 0.06)}${ring(x, yf, 0.12, c, MED, PAPER)}<circle cx="${F3(x)}" cy="${F3(yb)}" r="0.11" fill="${c}"/>${arrow}</g>`);
  }
  // 单看一层时，本层的带在升降点前后接着走的别层那几段（linkedRuns）画在本层下面：照带的颜色，又淡又细的虚线，
  // 一眼能分出不是这一层的；只是示意，不带 route-hit、点不中。总览和缩略图不画（用户 2026/10/19）
  if (!all && !mini) {
    const linked = linkedRuns(floors, level).map((run) => `<polyline points="${runPoints(run).map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')}" fill="none" stroke="${tint(run.itemId, routeColor(model, run.itemId))}" stroke-width="0.12" stroke-opacity="0.65" stroke-dasharray="0.25 0.3"/>`);
    if (linked.length) parts.push(`<g class="linked-runs" pointer-events="none">${linked.join('')}</g>`);
  }
  // 蓝底套线将跨层交叉隔开；层内保持真实格点，绝不平移线路。
  for (const floor of shown) {
    if (floor.z > 0) parts.push(sorterParts.splice(0).join('')); // 地面那层画完了：分拣器接在后面，高架的带再压在上面
    parts.push(`<g data-level="${floor.z}">`);
    for (const [index, run] of floor.runs.entries()) {
      const runId = `${floor.z}:${index}`;
      const c = tint(run.itemId, routeColor(model, run.itemId));
      // 坡上接着的那一格（from / to）也连上：只有一格的段带着坡也画成折线
      const line = runPoints(run);
      const pts = line.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
      if (!mini) {
        const hitAttrs = `class="route-hit" data-route-run="${runId}" tabindex="0" role="button" aria-label="${escape(model.items[run.itemId]?.name)}，L${floor.z + 1}，${run.cells.length} 格，查看线路简介" fill="none" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke" pointer-events="stroke"`;
        if (line.length > 1) hits.push(`<polyline points="${pts}" ${hitAttrs}/>`);
        else hits.push(`<circle cx="${X(run.cells[0][0])}" cy="${Y(run.cells[0][1])}" r="0.12" ${hitAttrs}/>`);
      }
      parts.push(`<g ${attrs(run.itemId)}>${title(`${model.items[run.itemId]?.name} · L${floor.z + 1} · z=${floor.z}`)}`);
      if (line.length === 1) {
        const [x, y] = run.cells[0];
        parts.push(`<rect x="${X(x) - 0.17}" y="${Y(y) - 0.17}" width="0.34" height="0.34" fill="${c}"/>`);
      } else {
        if (!mini) parts.push(`<polyline points="${pts}" fill="none" stroke="${PAPER}" stroke-width="0.52" stroke-linecap="square" stroke-linejoin="miter"/>`);
        parts.push(`<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="${mini ? 0.5 : selected === runId ? 0.46 : 0.3}" stroke-linecap="square" stroke-linejoin="miter" ${all && floor.z > 0 ? 'stroke-dasharray="0.52 0.2"' : ''}/>`);
        if (!mini) {
          // 固定间距加方向箭头；短段也至少显示一次。
          for (let i = run.cells.length > 3 ? 2 : 1; i < run.cells.length; i += 6) {
            const a = run.cells[i - 1], b = run.cells[i];
            const dx = b[0] - a[0], dy = -(b[1] - a[1]);
            const len = Math.hypot(dx, dy);
            if (!len) continue;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;
            parts.push(`<path d="M-0.22 -0.21L0.06 0L-0.22 0.21" transform="translate(${X(b[0])} ${Y(b[1])}) rotate(${angle})" fill="none" stroke="${c}" stroke-width="0.10"/>`);
          }
        }
      }
      parts.push('</g>');
    }
    if (!mini) {
      const grouped = new Map();
      for (const via of floor.vias) {
        const key = `${via.x},${via.y},${via.itemId}`;
        if (!grouped.has(key)) grouped.set(key, { ...via, to: [] });
        grouped.get(key).to.push(via.to + 1);
      }
      for (const via of grouped.values()) {
        const x = X(via.x), y = Y(via.y), c = tint(via.itemId, routeColor(model, via.itemId));
        parts.push(`<g ${attrs(via.itemId)}>${title(`${model.items[via.itemId]?.name} · L${floor.z + 1} ↔ ${via.to.map((z) => `L${z}`).join(' / ')} · ${via.direction > 0 ? '上行' : '下行'}`)}<rect x="${x - 0.27}" y="${y - 0.27}" width="0.54" height="0.54" fill="${PAPER}" stroke="${c}" stroke-width="0.1"/><path d="M${x - 0.12} ${y}H${x + 0.12}M${x} ${y - 0.12}V${y + 0.12}" stroke="${c}" stroke-width="0.08"/></g>`);
      }
    }
    parts.push('</g>');
  }
  parts.push(sorterParts.splice(0).join('')); // 单看 L1 时接在地面那层后面
  // 分馏阵列里的小设备（压在带子上）：自动集装机是小方框里三道横线（叠起来），四向分流器是方框加十字，喷涂机是菱形
  if (!mini && (all || level === 0)) for (const dv of model.devices || []) {
    const x = X(dv.x), y = Y(dv.y);
    const name = { piler: '自动集装机', splitter: '四向分流器', coater: '喷涂机' }[dv.kind] ?? dv.kind;
    let body;
    if (dv.kind === 'piler') body = `<path d="${rectD(x - 0.3, y - 0.3, x + 0.3, y + 0.3)}" fill="${PAPER}" stroke="${LINE}" stroke-width="${MED}"/><path d="M${F3(x - 0.18)} ${F3(y - 0.12)}h0.36M${F3(x - 0.18)} ${F3(y)}h0.36M${F3(x - 0.18)} ${F3(y + 0.12)}h0.36" stroke="${FINE}" stroke-width="${THIN}"/>`;
    else if (dv.kind === 'splitter') body = `<path d="${rectD(x - 0.34, y - 0.34, x + 0.34, y + 0.34)}" fill="${PAPER}" stroke="${LINE}" stroke-width="${MED}"/><path d="M${F3(x)} ${F3(y - 0.22)}V${F3(y + 0.22)}M${F3(x - 0.22)} ${F3(y)}H${F3(x + 0.22)}" stroke="${FINE}" stroke-width="${THIN * 1.4}"/>`;
    else body = `<path d="M${F3(x)} ${F3(y - 0.32)}L${F3(x + 0.32)} ${F3(y)}L${F3(x)} ${F3(y + 0.32)}L${F3(x - 0.32)} ${F3(y)}Z" fill="${PAPER}" stroke="${FINE}" stroke-width="${MED}"/>`;
    parts.push(`<g class="device">${title(name)}${body}</g>`);
  }
  if (!mini && model.power && (all || level === 0 || power)) for (const n of model.power.nodes) {
    // 供电设施沿用旧版画法：电力感应塔是一个黄圈，里面一个「+」；卫星配电站是圆角方框加「+」
    const x = X(n.x), y = Y(n.y), z = model.power.size;
    const body = z > 1
      ? `<rect x="${x - z / 2 + 0.1}" y="${y - z / 2 + 0.1}" width="${z - 0.2}" height="${z - 0.2}" rx="0.3" fill="rgba(255,214,102,0.18)" stroke="${POWER}" stroke-width="0.1"/><path d="M${x} ${y - 0.8}V${y + 0.8}M${x - 0.8} ${y}H${x + 0.8}" stroke="${POWER}" stroke-width="0.12"/>`
      : `<circle cx="${x}" cy="${y}" r="0.36" fill="rgba(255,214,102,0.25)" stroke="${POWER}" stroke-width="0.09"/><path d="M${x} ${y - 0.22}V${y + 0.22}M${x - 0.22} ${y}H${x + 0.22}" stroke="${POWER}" stroke-width="0.08"/>`;
    parts.push(`<g>${title(model.power.name)}${body}</g>`);
  }
  const marks = []; // 原料入口的物品图标：等标尺画完再放，压在标尺上面
  if (!mini) for (const route of model.routes || []) {
    for (const [enabled, p, kind] of [[route.inPort, route.cells[0], '原料入口'], [route.outPort, route.cells.at(-1), '成品出口']]) {
      if (!enabled || !p || (!all && zKey(p[2]) !== level)) continue;
      const x = X(p[0]), y = Y(p[1]);
      const bp = rot ? [p[1] + oy, W - 1 - (p[0] + ox)] : [p[0] + ox, p[1] + oy]; // 提示里的坐标按出出来的蓝图说
      parts.push(`<g ${attrs(route.itemId)}>${title(`${kind} · ${model.items[route.itemId]?.name} · (${bp[0]}, ${bp[1]})`)}<circle cx="${x}" cy="${y}" r="0.46" fill="none" stroke="${tint(route.itemId, routeColor(model, route.itemId))}" stroke-width="0.1" ${kind === '原料入口' ? 'stroke-dasharray="0.18 0.12"' : ''}/></g>`);
      // 原料入口旁边的物品图标（只有带子、箱子送料才有入口，物流站没有）：口在左右边上（或往里一格）就放到图框外面、贴着框，
      // 在图里面的（箱子的出口）放在圈上面；竖排时转回来摆正
      const g = kind === '原料入口' && icon?.(route.itemId);
      if (!g) continue;
      const edge = x <= 1.5 || x >= W - 1.5;
      const ix = !edge ? x : x < W / 2 ? -0.55 : W + 0.55, iy = edge ? y : y - 0.95;
      marks.push(`<g class="port-icon" ${attrs(route.itemId)} transform="translate(${F3(ix)} ${F3(iy)})${spin ? ` rotate(${-spin})` : ''}">${title(`原料入口 · ${model.items[route.itemId]?.name}`)}<rect x="-0.5" y="-0.5" width="1" height="1" fill="${PAPER}" stroke="${FINE}" stroke-width="0.04"/>${g}</g>`);
    }
  }
  const turn = `matrix(0 1 -1 0 ${H} 0)`; // 横排坐标 (u, v) → 显示坐标 (H − v, u)：顺时针转 90°
  if (rot) {
    const inner = parts.splice(c0);
    parts.push(`<g transform="${turn}">${inner.join('')}</g>`);
    spin = 0;
  }
  // 外框、尺寸线、标尺都按显示出来的宽长画
  {
    const W = DW, H = DH;
  parts.push(`<rect width="${W}" height="${H}" fill="none" stroke="#82a2c3" stroke-width="0.07"/>`);
  if (!mini) {
    parts.push(`<g class="dimension-lines" fill="none" stroke="#8cadd0" stroke-width="0.05"><path d="M0 -0.4V-1.35M${W} -0.4V-1.35M0 -1.35H${W}M-0.2 -1.1L0.2 -1.6M${W - 0.2} -1.1L${W + 0.2} -1.6M${W + 0.4} 0H${W + 1.35}M${W + 0.4} ${H}H${W + 1.35}M${W + 1.35} 0V${H}M${W + 1.1} -0.2L${W + 1.6} 0.2M${W + 1.1} ${H - 0.2}L${W + 1.6} ${H + 0.2}"/></g>`);
    parts.push(`<rect x="${W / 2 - 2.1}" y="-1.9" width="4.2" height="1" fill="${PAPER}"/>${text(W / 2, -1.35, `${W}x`, 0.6, '#bfd5ec')}<g transform="translate(${W + 1.35} ${H / 2}) rotate(-90)"><rect x="-2.1" y="-0.5" width="4.2" height="1" fill="${PAPER}"/>${text(0, 0, `${H}x`, 0.6, '#bfd5ec')}</g>`);
    // 标尺直接使用蓝图坐标，origin 只用于几何映射，避免二次平移。
    const ticks = [];
    for (let x = 0; x < W; x++) ticks.push(`M${x + 0.5} ${H}v${x % 5 === 0 ? 0.24 : 0.1}`);
    for (let y = 0; y < H; y++) ticks.push(`M0 ${H - y - 0.5}h-${y % 5 === 0 ? 0.24 : 0.1}`);
    parts.push(`<path d="${ticks.join('')}" fill="none" stroke="#8cadd0" stroke-width="0.04"/>`);
    for (let x = 0; x < W; x += 5) parts.push(text(x + 0.5, H + 0.95, x, 0.62, '#a1bcd8'));
    for (let y = 0; y < H; y += 5) parts.push(text(-0.85, H - y - 0.5, y, 0.62, '#a1bcd8'));
  }
  }
  if (marks.length) parts.push(rot ? `<g transform="${turn}">${marks.join('')}</g>` : marks.join(''));
  const hitLayer = rot && hits.length ? `<g transform="${turn}">${hits.join('')}</g>` : hits.join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mini ? `-0.6 -0.6 ${DW + 1.2} ${DH + 1.2}` : `-2 -2.3 ${DW + 4.3} ${DH + 4.3}`}" ${mini ? 'aria-hidden="true"' : `role="group" aria-label="${escape(label)}，${DW} 乘 ${DH} 格"`}>${parts.join('')}${hitLayer}</svg>`;
}
