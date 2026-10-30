// route() 各步共用的常量和小工具

export const TOL = 1e-6;

/** 物流站靠左侧：站占最左 7 列（中心 x=3），紧挨着一列主干走廊（x=7），生产区从第 8 列开始 */
export const STATION_SIZE = 7;
export const TRUNK = STATION_SIZE; // 主干走廊所在的列
export const STATION_COLS = STATION_SIZE + 1; // 站列 + 走廊共占几列
export const STATION_SLOTS = 5; // 星际物流站的存储格数
export const WARPER = 1210; // 空间翘曲器
/**
 * 物流站的额外格子（用户 2026/10/07，左栏「物流站格子」）：slots = { warper, keepFree }，都是整张蓝图留一格，不是每座站一格：
 *   warper：一座站存空间翘曲器（星际需求），别的站用传送带从它那里接（plan/stations.js 的 linkWarpers；
 *           传送带送进星际物流站的翘曲器自动进站里专门的翘曲器仓，不占物品格）。用户 2026/10/07：引力矩阵 120 三座站，两格就够；
 *   keepFree：喷增产剂时至少留一个空格给增产剂（增产剂带从站里出来；站都满了的话原料就喷不上）。
 * 所以每座站照旧最多 5 种产线物品，分完组后整张一共留够空格。
 */
export const stationItemCap = () => STATION_SLOTS;
/** 整张要留几个空格：增产剂一格、翘曲器一格 */
export const reservedSlots = (slots) => (slots?.keepFree ? 1 : 0) + (slots?.warper ? 1 : 0);
/** 分完组空格不够留（增产剂、翘曲器）时，从最后一座挪最后一种出来单开一座，直到够 */
export function keepFreeSlot(groups, slots) {
  const need = reservedSlots(slots);
  const free = () => groups.reduce((n, g) => n + STATION_SLOTS - g.length, 0);
  while (groups.length && free() < need) groups.push([groups[groups.length - 1].pop()]);
  return groups;
}

/** 0..n-1 的全部排列（n ≤ 4；4 条轨道只在 opt.fourthTrack 时用到，见 layout/tracks.js） */
export const TRACK_PERMS = { 0: [[]], 1: [[0]], 2: [[0, 1], [1, 0]], 3: [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]], 4: permutations([0, 1, 2, 3]) };

export function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((v, i) => {
    for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([v, ...p]);
  });
  return out;
}

/** 轨道定下来之前，估算竖直方向每跨一个通道大约多少格（通道 + 工厂行） */
export const CH_PITCH = 6;

/** 格子的数字键：比字符串键快得多（退火要调用几万次） */
export const gk = (x, y) => (x + 16) * 4096 + y + 16;

/** from 到 to（含两端）的整数序列，方向随 to 的大小 */
export function line(from, to) {
  const out = [];
  const step = to >= from ? 1 : -1;
  for (let v = from; v !== to + step; v += step) out.push(v);
  return out;
}

/**
 * 研究站夹带（layout/belts.js 的 labGaps）的 'out' 高架接着的那一头：带尾那格（原地升起那格）和链在那里往哪流（往北）。
 * 接站、接仓、接发电厂时寻路的终点就是它（普通段尾是 (exitX, y)、沿 dout 流）。返回 { x, y, dx, dy }
 */
export function gapEnd(L, leg) {
  const g = L.labGaps[leg.gap];
  return { x: g.x, y: g.y1, dx: 0, dy: 1 };
}

/** 侧边总线排到左边（route.js 的 busSide 'auto'）时最左那一列，就是左边总线口那一列（layout/ports.js）；没有排到左边的总线时 0 */
export function busMinX(ports) {
  let m = 0;
  for (let i = 0; i < ports.length; i++) if (ports[i].bus === true && ports[i].x < m) m = ports[i].x;
  return m;
}

/**
 * 边缘出入口往外的那一行（用户 2026/10/24：入口外面还有一层带子、上面再有高架就接不出去）：每个还从边缘进出的口
 * （不接站、仓、不就地烧），所在那一行从口外一格一直往外 RAY_OUT 格（接仓、接发电厂时寻路的地比布局宽，一直留到外面）。这些格子的地面留空：高架落地（plan/ground.js）、
 * 供电设施（plan/power.js）、增产剂带（plan/addons.js）、外面的仓组（plan/storage.js）、火力发电厂（plan/burn.js）都不占，
 * 外面的线能沿地面直接接进来（emit/check.js 的 3d 查）。skip(p)：这几个口不算（正在给它接仓、接发电厂的那个）。返回 [[x, y]]
 */
export function portRays(L, skip = null) {
  const out = [];
  for (const p of L.ports || []) {
    if (p.station != null || p.store != null || p.burn || skip?.(p)) continue;
    const d = p.x <= (L.width - 1) / 2 ? -1 : 1;
    for (let x = p.x + d; d < 0 ? x >= -RAY_OUT : x < L.width + RAY_OUT; x += d) out.push([x, p.y]);
  }
  return out;
}
/** portRays 往布局外延伸几格 */
const RAY_OUT = 64;
