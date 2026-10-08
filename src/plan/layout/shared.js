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
