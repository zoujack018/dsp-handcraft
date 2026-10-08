// 整张蓝图顺时针转 90°：和游戏里贴蓝图时按一下旋转完全一样——每个建筑的位置绕原点转、朝向（yaw）加 90°，
// 连接关系（谁接谁、接几号口）都不变，槽位跟着建筑一起转。竖排（行沿竖直方向）的产线就是横着排好以后整张转过来。
//   格坐标 (x, y) → (y, W − 1 − x)，W 是转之前的宽；朝向 0（北）→ 90（东），方向向量 (dx, dy) → (dy, −dx)。

/** 转一个点（转之前的宽 W） */
export const rotatePoint = (x, y, W) => ({ x: y, y: W - 1 - x });
/** 转一个方向向量 */
export const rotateVec = (dx, dy) => [dy, -dx];

/** 就地把解码后的蓝图对象顺时针转 90° */
export function rotateBlueprint(bp) {
  const W = bp.dragBoxSize.x;
  const H = bp.dragBoxSize.y;
  for (const b of bp.buildings) {
    b.localOffset = b.localOffset.map((o) => ({ ...rotatePoint(o.x, o.y, W), z: o.z }));
    b.yaw = b.yaw.map((v) => (((v + 90) % 360) + 360) % 360);
  }
  const size = { x: H, y: W };
  bp.dragBoxSize = size;
  bp.cursorOffset = { x: Math.floor(size.x / 2), y: Math.floor(size.y / 2) };
  for (const a of bp.areas || []) a.size = size;
  return bp;
}
