// 游戏数据访问层：物品、配方、工厂。全部以 ID 为主键，名称只用于显示和输入。
import vanilla from '../data/Vanilla.json' with { type: 'json' };

/** 游戏数据里制造台名称带不间断空格（ ），统一成普通空格 */
export const normName = (s) => String(s).replace(/ /g, ' ').trim();

export const ITEMS = new Map();
const ITEM_BY_NAME = new Map();
for (const it of vanilla.items) {
  // power：建筑工作时的功率（瓦），游戏数据里是每 tick 的焦耳数（一秒 60 tick）
  const item = { id: it.ID, name: normName(it.Name), type: it.Type, speed: it.Speed, power: (it.WorkEnergyPerTick ?? 0) * 60 };
  ITEMS.set(item.id, item);
  ITEM_BY_NAME.set(item.name, item);
}

export const RECIPES = new Map();
const PRODUCERS = new Map(); // itemId -> recipe[]
for (const r of vanilla.recipes) {
  const recipe = {
    id: r.ID,
    name: normName(r.Name),
    type: r.Type, // 1 冶炼 2 化工 3 精炼 4 制造 15 研究站 -1 黑雾掉落 ...
    factories: r.Factories,
    inputs: r.Items.map((id, i) => ({ id, count: r.ItemCounts[i] })),
    outputs: r.Results.map((id, i) => ({ id, count: r.ResultCounts[i] })),
    time: r.TimeSpend / 60, // 秒
    proliferator: r.Proliferator ?? 0, // 能不能喷增产剂：1 只能加速，3 加速或增产，0 都不行
  };
  RECIPES.set(recipe.id, recipe);
  for (const o of recipe.outputs) {
    if (!PRODUCERS.has(o.id)) PRODUCERS.set(o.id, []);
    PRODUCERS.get(o.id).push(recipe);
  }
}

/** 游戏里的原矿（物品 Type 1），默认由物流站供应 */
export const RAW_ITEM_IDS = new Set(vanilla.items.filter((i) => i.Type === 1).map((i) => i.ID));

export function item(idOrName) {
  if (typeof idOrName === 'number') {
    const it = ITEMS.get(idOrName);
    if (!it) throw new Error(`未知物品 ID ${idOrName}`);
    return it;
  }
  const it = ITEM_BY_NAME.get(normName(idOrName));
  if (!it) throw new Error(`未知物品「${idOrName}」`);
  return it;
}

export function recipe(idOrName) {
  if (typeof idOrName === 'number') {
    const r = RECIPES.get(idOrName);
    if (!r) throw new Error(`未知配方 ID ${idOrName}`);
    return r;
  }
  for (const r of RECIPES.values()) if (r.name === normName(idOrName)) return r;
  throw new Error(`未知配方「${idOrName}」`);
}

export const recipesProducing = (itemId) => PRODUCERS.get(itemId) || [];

/**
 * 增产剂（喷涂机喷在原料上）：等级 1~3 = Mk.I~Mk.III。
 *   extra  增产：每次多出这么多产物（原料不变）       speed  加速：工厂快这么多（原料、产物同比例）
 *   sprays 一个增产剂能喷多少个原料
 * 配方能增产（Proliferator 含 2）就按增产算，只能加速（Proliferator 1）就按加速算。数值是游戏里的标准值。
 */
export const SPRAY_LEVELS = [
  null,
  { level: 1, item: 1141, name: '增产剂 Mk.I', extra: 0.125, speed: 0.25, sprays: 12 },
  { level: 2, item: 1142, name: '增产剂 Mk.II', extra: 0.2, speed: 0.5, sprays: 24 },
  { level: 3, item: 1143, name: '增产剂 Mk.III', extra: 0.25, speed: 1, sprays: 60 },
];

/**
 * 工厂几何（单位：格；坐标以工厂中心所在格为原点，y 向上）。
 *   pitch        同一块里相邻两台的中心距
 *   center       块左端到第一台中心的距离
 *   trailing     块宽比 台数 × pitch 多的列数（对撞机 1：补左边空的那 1 列）
 *   bodyWidth    本体占的列数（化工厂 7、对撞机 9）
 *   bodyBelow/bodyAbove  本体在中心下方/上方占几行
 *   edgeBelow/edgeAbove  分拣器在工厂一端的落点离中心几行（下侧 / 上侧）
 *   edgeShiftBelow       下侧落点再往上挪的小数（化工厂 0.284，照抄 antian 已验证的写法）
 *   slots        分拣器落在各列（相对工厂中心的偏移）时对应的槽位号；没列出的列不能接分拣器
 *   slotPos      槽位的精确位置 [dx, dy]（相对工厂中心）：研究站、对撞机的槽位不在整格上，分拣器两端都对齐到槽位的 x，
 *                接到最近那格带子（玩家 2026/10/04 的参考蓝图）。没有 slotPos 的工厂按「列, ±edge」落点
 *   tap          分拣器那三列的中间一列相对工厂中心的偏移（一般是 0，对撞机是 −2：接口偏在左边）
 *   collider     独立检查用的碰撞体 [宽, 高]
 *   colliderShift  碰撞体中心相对工厂中心的偏移 [dx, dy]（化工厂往上 0.5：本体下 1 上 2；对撞机往左 0.3）
 * 熔炉 3 格、制造台 4 格的间距和化工厂的槽位都沿用 antian369 已在游戏里验证过的写法
 * （制造台实际碰撞体约 3.2×3.2，3 格间距会重叠，所以取 4）。
 * 化工厂 7、对撞机 9 是 2026/10/05 体积测试的结果（C7 两台化工厂隔 7 能放；C9 两台对撞机隔 9 能放、C10 隔 8 变红），
 * 以前照 antian 用 8、10。同一块里相邻两台本体紧挨着。
 * 和别的块挨着（体积测试第二张，tools/volume-test2.js）：化工厂两边紧挨熔炉、制造台都能放（E1~E4），所以块的两头不留空列；
 * 对撞机左右不对称（右边紧挨熔炉、制造台能放，左边紧挨熔炉能放、紧挨制造台不行），块左边空 1 列（center 5，块宽 9n + 1）、右边直接挨下一块，
 * 右边接熔炉时中心隔 6（E6 实测能放），左边接制造台时中心隔 7（第三张 H7 实测能放）。
 */
const SLOTS_3x3 = { bottom: { 1: 6, 0: 7, [-1]: 8 }, top: { [-1]: 0, 0: 1, 1: 2 } };
const BOX3 = { bodyWidth: 3, bodyBelow: 1, bodyAbove: 1, edgeBelow: 1, edgeAbove: 1, edgeShiftBelow: 0, trailing: 0, slots: SLOTS_3x3 };
const FACTORY_GEOMETRY = {
  smelter: { ...BOX3, pitch: 3, center: 1, collider: [2.4, 2.4], supported: true },
  assembler: { ...BOX3, pitch: 4, center: 2, collider: [3.2, 3.2], supported: true },
  // 化工厂：antian 的模板 area [4,2]、inserterBorder 上 2 下 1；槽位 上排左到右 0 1 2 7，下排 6 5 4 3
  chemical: {
    pitch: 7,
    center: 3,
    trailing: 0,
    bodyWidth: 7,
    bodyBelow: 1,
    bodyAbove: 2,
    edgeBelow: 1,
    edgeAbove: 2,
    edgeShiftBelow: 0.284,
    slots: { bottom: { [-1]: 6, 0: 5, 1: 4 }, top: { [-1]: 0, 0: 1, 1: 2 } },
    // 碰撞体宽 6~6.8（隔 7 能放、隔 6 变红；两边紧挨制造台能放，3.4 + 1.6 ≤ 5），取 6.8；上下就是本体那 4 行（站紧贴它下沿能放，G4）
    collider: [6.8, 4],
    colliderShift: [0, 0.5],
    supported: true,
  },
  refinery: { pitch: 7, bodyHeight: 3, supported: false },
  // 微型粒子对撞机：Buildings.json area [5, 2.5]、inserterBorder 上 2 下 2。以前按碰撞体 10×5、间距 10（antian369 的写法）；
  // 2026/10/05 体积测试两台隔 9 能放、隔 8 变红，间距 9。碰撞体往左偏（第二张 E6~E9、G2）：按 9×5、中心往左 0.3 格算，
  // 左边伸出 4.8、右边 4.2（3.2 宽的制造台贴左边要隔 6.4 以上，2.4 宽的熔炉贴左边隔 6 正好，物流站贴左边 3.4 + 4.8 > 8），偏多少是推断；
  // 第三张 H6（站贴右边）、H7（制造台在左边隔 7）都能放，和推断一致。
  // 槽位按玩家 2026/10/04 的参考蓝图（对撞机在 (5,6)，上下两排带在 y=9 / y=3）：上下两侧的槽位都挤在中心左边，
  // 上侧 0/1/2 号在 x−0.8/−1.6/−2.4，下侧 6/7/8 号在 x−2.4/−1.6/−0.8，落点 y ±1.83；左侧 3/4/5 号，右侧没有。
  // 分拣器两端对齐槽位的 x，接最近那格带子，所以只有 x−2、x−1 两列能接（−1.6 和 −2.4 都落在 x−2 那格，取 −1.6 那个），
  // 每侧最多 2 根，4 根正好够奇异物质（3 进 1 出）。
  collider: {
    pitch: 9,
    center: 5,
    trailing: 1,
    bodyWidth: 9,
    bodyBelow: 2,
    bodyAbove: 2,
    edgeBelow: 2,
    edgeAbove: 2,
    edgeShiftBelow: 0,
    tap: -2,
    slots: { bottom: { [-2]: 7, [-1]: 8 }, top: { [-2]: 1, [-1]: 0 } },
    // 左侧 3/4/5 号规划器不用（排成行时左右是邻居），列出来给独立检查认手搓的蓝图
    slotPos: { 0: [-0.803, 1.828], 1: [-1.605, 1.827], 2: [-2.407, 1.826], 6: [-2.401, -1.831], 7: [-1.6, -1.83], 8: [-0.8, -1.829], 3: [-3.849, 0.789], 4: [-3.847, -0.006], 5: [-3.844, -0.801] },
    collider: [9, 5],
    colliderShift: [-0.3, 0],
    supported: true,
  },
  // 研究站：Buildings.json area [3,3,3]、inserterBorder 上 2 下 2；碰撞体约 4.5×4.5（占地 20.25 开方）。
  // 间距 5：玩家 2026/10/04 实测两叠研究站中心隔 5 格能建（以前照 antian369 用 6）；本体 5 列紧挨着，相邻两台的分拣器列（中心 −1/0/+1）不重叠。
  // 槽位按玩家 2026/10/04 的参考蓝图（研究站在 (14,6)，带在 y=9 / y=3）：槽位在 x−0.8/0/+0.8，落点 y ±1.83，
  // 下侧 6/7/8 号从左到右，上侧 0/1/2 号是从右到左（上侧 x+1→0、x→1、x−1→2，以前写反了）；左侧 3/4/5、右侧 11/10/9 号都是从上到下。
  // 可以竖着叠：上面一台的 inputObjIdx 指向下面一台（inputFromSlot 15、outputToSlot 14），每层高 3（levelZ），
  // 分拣器只接最底下那台，原料往上传、产物往下传。能叠几层看「垂直建造」科技，由玩家自己填。
  lab: {
    pitch: 5,
    center: 2,
    trailing: 0,
    bodyWidth: 5,
    bodyBelow: 2,
    bodyAbove: 2,
    edgeBelow: 2,
    edgeAbove: 2,
    edgeShiftBelow: 0,
    slots: { bottom: { [-1]: 6, 0: 7, 1: 8 }, top: { 1: 0, 0: 1, [-1]: 2 } },
    slotPos: {
      ...{ 0: [0.803, 1.828], 1: [0, 1.829], 2: [-0.803, 1.828], 6: [-0.8, -1.829], 7: [0, -1.829], 8: [0.8, -1.829] },
      ...{ 3: [-1.844, 0.794], 4: [-1.843, 0], 5: [-1.842, -0.796], 9: [1.842, -0.796], 10: [1.843, 0], 11: [1.844, 0.794] }, // 左右两侧规划器不用
    },
    collider: [4.5, 4.5],
    levelZ: 3,
    supported: true,
  },
};
/**
 * 同类里比基础款大的高级款（按建筑 ID 覆盖 FACTORY_GEOMETRY）。
 * 量子化工厂：2026/10/07 第五张体积测试 J1（两台隔 7）、J2（化工厂和它隔 7）、J6（它和制造台 Mk.III 隔 5）都变红，
 * J3（上下中心差 5 正对着）能放：比化工厂宽、一样高。宽至少 7.2（J2），取游戏数据里的占地宽 8（Buildings.json area [4,2]）。
 * 间距 8、块右边空 1 列（中心 4、块宽 8n + 1）：右边紧挨熔炉时中心隔 6（4 + 1.2 ≤ 6），左右挨制造台、化工厂、研究站、对撞机也都够；
 * 本体按 9 格占格子（碰撞体 ±4 压到两边那格的一半）。上下、槽位照化工厂：用户 2026/10/07 把按这套规则排的卡西米尔晶体 60
 * （9 台量子化工厂，同类隔 8）和引力矩阵 90（量子化工厂 + Mk.III + 负熵熔炉 + 自演化研究站）贴进游戏，都能放、分拣器都接上了。
 * 研究站、熔炉、制造台的高级款（K2、K3、K7、M1~M4）实测和基础款一样大，不用覆盖。
 */
const GEOMETRY_BY_ID = {
  2317: { pitch: 8, center: 4, trailing: 1, bodyWidth: 9, collider: [8, 4] },
};
/**
 * 高纬度版的化工厂、量子化工厂（用户 2026/10/07：不在赤道上，隔 7 的化工厂就会撞，无法建造的概率很高。
 * 先做了生成时弹窗问，用户随后改主意：默认一律用这套加宽的间距，左栏「化工厂赤道间距压缩」打开才用赤道那套，bug 少）。
 * 为什么：游戏的格子南北方向一样宽，东西方向一圈的格数按纬度分段（PlatformSystem.DetermineLongitudeSegmentCount + segmentTable，
 * 半径 200 的星球：赤道 1000 格，28.8° 起 800、46.8° 起 600、55.8° 起 500、64.8° 起 400、70.2° 起 300、75.6° 起 200……），
 * 同一段里越往北格子越窄：东西向格宽 = cos(纬度) × 1000 ÷ 这一段的格数，赤道到 28.8° 从 100% 缩到 88%，往后每段在 83%~100% 之间来回。
 * 建筑本身的大小不变，蓝图里东西方向隔几格，贴到别的纬度就是隔几个窄格子。化工厂碰撞体宽按 6.8 算、隔 7 只有 3% 的余量，
 * 纬度 13.8°~28.8°、39°~46.8° 等处都会撞（赤道版只在每段靠赤道的一头能放）。
 * 高纬度版每台左右各多留 1 格，按本体加宽占格子（站、供电设施、带子也都离开这一格）：化工厂间距 8、块两头各空 1 列（中心 4、块宽 8n + 1），
 * 要格宽 ≥ 85%，85° 以内只有 64.8°、70.2°、75.6°、82.9° 这几条分界线南边不到 1° 的窄条不够；
 * 量子化工厂碰撞体按 8 算（实测 7.2~8 之间），间距 10、中心 5、块宽 10n + 1，要格宽 ≥ 80%，82.6° 以内都够。
 * 别的建筑（研究站隔 5、对撞机隔 9）余量也小，用户还没说撞，先不动。
 */
const GEOMETRY_HIGH_LATITUDE = {
  2309: { pitch: 8, center: 4, trailing: 1, bodyWidth: 9 },
  2317: { pitch: 10, center: 5, trailing: 1, bodyWidth: 11 },
};
const FACTORY_KIND = {
  2302: 'smelter', 2315: 'smelter', 2319: 'smelter',
  2303: 'assembler', 2304: 'assembler', 2305: 'assembler', 2318: 'assembler',
  2309: 'chemical', 2317: 'chemical',
  2308: 'refinery',
  2310: 'collider',
  2901: 'lab', 2902: 'lab',
};

/**
 * latitude：'high' 时化工厂、量子化工厂用高纬度版的间距（GEOMETRY_HIGH_LATITUDE），'equator' 用赤道压缩的间距，别的工厂不变。
 * 这里默认 'equator' 是工厂本来的几何（独立检查、体积测试按碰撞体查，和间距无关）；规划默认用哪套看 calculate() 的 latitude。
 * 化工厂、量子化工厂的返回值带 latitude，说明这次按哪套间距排。
 */
export function factory(id, latitude = 'equator') {
  const kind = FACTORY_KIND[id];
  if (!kind) throw new Error(`未知工厂 ID ${id}`);
  const it = ITEMS.get(id);
  const high = latitude === 'high' ? GEOMETRY_HIGH_LATITUDE[id] : null;
  const geo = { ...FACTORY_GEOMETRY[kind], ...GEOMETRY_BY_ID[id], ...high };
  return { id, name: it.name, speed: it.speed, kind, ...geo, bodyHeight: (geo.bodyBelow ?? 1) + (geo.bodyAbove ?? 1) + 1, ...(id in GEOMETRY_HIGH_LATITUDE ? { latitude: high ? 'high' : 'equator' } : null) };
}
/** 这台工厂有没有高纬度版（化工厂、量子化工厂） */
export const hasHighLatitude = (id) => id in GEOMETRY_HIGH_LATITUDE;

// 传送带相邻两节在水平方向走一格时，高度最多变几层。玩家实测：一步升 1 层能建、一步跨 3 层报"无法建造"；
// 但 2026/10/03 用户对比了游戏里手动拉的官方垂直传送带：官方就是同一格里竖直叠放（每节差 1 层），
// 前后都是水平直走，没有斜坡；程序出的「一格斜坡」看起来是折的，用户认为不该用。所以现在不用斜坡（0）：
// 高架都在地面那一格原地竖直升到第 L 层，再水平走，落下时同样原地竖直落到地面。
export const RAMP_MAX_DZ = 0;
/**
 * 两座星际物流站中心之间的最小直线距离（格）。用户实测：
 *   2026/10/03 同一列：(−2, 8) 和 (−2, −16) 能建（隔 24 格），隔 23 格不行；
 *   2026/10/04 斜着放：A 在 (−190, 0)，B 在 (−178, 20) (−180, 21) (−183, 22) (−175, 18) (−176, 19) (−172, 15) (−170, 12)
 *   都能建，直线距离 23.09~23.60 格。
 * 和「直线距离 ≥ 29 m」吻合：29 m ÷ 1.2566 m/格 = 23.08 格。但东西方向的格子越往高纬度越窄（同样的格数米数更少），
 * 斜着相对时尤其拿不准，所以再加 1 格余量（玩家 2026/10/04）：24.08。
 */
export const STATION_GAP = 24.08;
/**
 * 物流站身（7×7）外面还有 1 格碰撞圈（玩家 2026/10/04 的「真实体积 / 碰撞体积」模型）：站在 (−381,−4) 时卫星配电站（3×3）
 * 要到 (−381,−10) 才能建、(−381,−9) 不行，也就是配电站和站身之间要空 1 格。按 9×9 的方形算：斜对着的 (5,5) 在那次实测里能放，
 * 但不同纬度格子形状不一样，斜着相对那种不保险，不抠角。
 * 2026/10/05 体积测试：这一圈只挡卫星配电站（D2 正对隔 5、D3 斜对 (5,5) 变红；那次斜对着也不行了，说明和纬度有关）；
 * 电力感应塔、制造台、熔炉、叠层研究站、带子都能贴着站身（D4~D10），所以规划和检查都只让卫星配电站不进这一圈。
 * 这里是站中心到这一圈外沿的格数（站身是 3）。
 */
export const STATION_CLEAR = 4;
/**
 * 判物流站和工厂碰撞时站身的半宽（格）。站身占 7×7，但制造台本体紧贴站身（中心隔 5）实测能放（体积测试 D6），
 * 而制造台碰撞体确实大于 3 格（C3、C4 两台隔 3 变红，按 3.2 算），按 3.5 + 1.6 > 5 会误报，所以站这边取 3.4。
 */
export const STATION_HALF = 3.4;
/**
 * 卫星配电站占 3×3（玩家 2026/10/04 第三张实测图：它和熔炉一样，真实体积只有中间 1×1，外面一圈是碰撞体积）。
 * 上一版按「5×5 去四角」算是错的：那张图里配电站离制造台、熔炉中心 3 格都能放。
 * 紧挨着制造台、熔炉放（中心隔 3，本体之间不留缝）实测可以。
 * 供电设施之间另有最小间距（2026/10/05 体积测试图：两座配电站中心隔 3 变红、隔 6 能放；配电站和电力感应塔隔 2 变红、
 * 斜对角 (2,2) 能放；两座电力感应塔紧挨着变红。第二张：两座配电站隔 4、5 也变红；两座塔隔 2、斜对角挨着都变红。
 * 第三张：两座塔错开 (2,1) 变红，斜对 (2,2)、隔 3、错开 (3,1) 能放；配电站和塔正对隔 3 能放）。
 * 按中心直线距离算，取实测能放的最小值：
 */
export const SUBSTATION_GAP = 6;
/** 两座供电设施中心的最小直线距离（格）：配电站之间 6、配电站和塔 2√2、塔之间 2√2（2.24 不行、2.83 能放） */
export function powerGap(a, b) {
  if (a === 2212 && b === 2212) return SUBSTATION_GAP;
  return Math.SQRT2 * 2;
}
/** 供电设施中心在 (x, y) 时占的格子：电力感应塔 1 格，卫星配电站 3×3 */
export function powerCells(itemId, x, y) {
  if (itemId !== 2212) return [[x, y]];
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push([x + dx, y + dy]);
  return out;
}
/**
 * 供电设施能不能紧贴工厂本体放（不隔那 1 格缝）。玩家实测：
 *   卫星配电站紧挨制造台、熔炉（中心隔 3）可以（2026/10/04 第三张图、2026/10/05 体积测试 A1 A3）；
 *   电力感应塔能塞进所有制造台之间的缝（B1~B4）、紧贴熔炉（B6）、研究站隔 6 的缝（B8）（2026/10/03 那次「Mk.I 塞不进」的结论作废），
 *   紧贴化工厂两边（体积测试第二张 F1 F2）、对撞机两边（第二张 F3、第三张 H5）：所有工厂都可以贴。
 * 卫星配电站对化工厂、研究站、对撞机见 substationPad（第六张体积测试）。
 */
export function powerHugs(powerItemId, g) {
  if (powerItemId === 2212) return g.kind === 'smelter' || g.kind === 'assembler' || (g.kind === 'lab' && (g.levels ?? 1) <= 1);
  return true;
}
/**
 * 卫星配电站离各种工厂要留多远（2026/10/07 体积测试第六张，tools/volume-test6.js）。用户的信息矩阵 59 贴进游戏，配电站撞了叠 10 层的研究站，这张图量清楚：
 *   研究站：单层紧贴、斜对角都能放（N1 N8）；叠 10 层时紧贴（N5 N7）、斜对角 (4,4)（N2）都撞，隔 1 格（N6）、(5,4)（N4）、(5,5)（N3）能放
 *     ——高度有关系，推测配电站上半截比底座宽；叠 2~9 层没量，按叠层算（保守）；
 *   化工厂：左右紧贴、上沿紧贴、各个斜角都能放（P1~P6、P8），只有紧贴下沿撞（P7）；
 *   对撞机：左右、上沿紧贴、斜角都撞（Q1~Q4），隔 1 格没量。
 * 返回两样：pad 规划器在工厂本体外多算占用的格数 { x, below, above }（x 是左右各几格，上下的那几行只占本体那几列），
 * margin 独立检查里配电站 3×3 和工厂碰撞体之间至少要隔的距离 { side, below, above }（按工厂自己的朝向，side 是左右）。
 * 熔炉、制造台、单层研究站都是 0（可以贴，A1 A3、N1 N8）。
 * 2026/10/07 用户的石墨烯 3600（48 台化工厂、4 座配电站）在赤道上贴进游戏，配电站撞了化工厂。那张图里贴着化工厂的三座都在第六张没量过的位置：
 * 两座紧贴化工厂左边（其中一座夹在同一行两台化工厂中间，右边也紧贴，但往上错 1 行）、一座紧贴右边往上错 1 行且在另一台化工厂下沿隔 1 行；
 * 量过能放的只有右边紧贴不错行（P4）。分不出是哪一种撞，所以规划器左右都隔 1 格（推断：配电站上半截比底座宽，隔 1 格叠层研究站就能放，N6），
 * 下沿照旧隔 1 行；独立检查只按实测报（P4 紧贴能放），不跟着收紧。量清楚哪种撞了再放宽。
 */
export function substationPad(g) {
  // 2026/10/08 验证合集实测（S 组），接着第六张图：
  //   化工厂：左边紧贴撞、左边隔 1 格能放；右边紧贴（含上下错 1 行）能放；下沿紧贴撞；上沿、斜角能放 → 左 1 格、下 1 行，右、上不留
  //   研究站叠 2~8 层右边紧贴都撞，叠 5 层斜角、上面紧贴也撞（单层能贴）→ 叠层四周 1 格（实测 2~8 层、10 层）
  //   对撞机：右边、上面、右上斜角隔 1 格能放；左边隔 1 格撞、下面紧贴和隔 1 格都撞 → 左 2 格、下 2 行（隔 2 没量，推断），右、上 1 格
  // pad 是规划器留的格数，margin 是独立检查里配电站 3×3 和碰撞体之间要隔开的距离（紧贴能放的为 0）
  if (g.kind === 'chemical') return { pad: { left: 1, right: 0, below: 1, above: 0 }, margin: { left: 0.5, right: 0, below: 0.5, above: 0 } };
  if (g.kind === 'lab' && (g.levels ?? 1) > 1) return { pad: { left: 1, right: 1, below: 1, above: 1 }, margin: { left: 1, right: 1, below: 1, above: 1 } };
  if (g.kind === 'collider') return { pad: { left: 2, right: 1, below: 2, above: 1 }, margin: { left: 1.5, right: 0.5, below: 1.5, above: 0.5 } };
  if (g.kind === 'smelter' || g.kind === 'assembler' || g.kind === 'lab') return { pad: { left: 0, right: 0, below: 0, above: 0 }, margin: null };
  return { pad: { left: 1, right: 1, below: 0, above: 0 }, margin: null };
}
/**
 * 分拣器在工厂一端的落点（相对工厂中心）。off = 分拣器所在列（接的那格带子的 x）− 工厂中心。
 * 有 slotPos 的工厂（研究站、对撞机）用槽位的精确位置，分拣器整根对齐到这个 x；其他工厂落在本列，y 为 ±edge。
 */
export function slotPoint(g, side, off) {
  const slot = g.slots?.[side]?.[off];
  const exact = slot == null ? null : g.slotPos?.[slot];
  if (exact) return { slot, dx: exact[0], dy: exact[1] };
  return { slot, dx: off, dy: side === 'bottom' ? -g.edgeBelow + (g.edgeShiftBelow ?? 0) : g.edgeAbove };
}
/**
 * 副产物（比如石墨烯高效配方多出来的氢）在生产图里单独走一条带、单独送出，和产线自己要用的同种物品分开。
 * 生产图里它的物品编号是「真实编号 + BYPRODUCT」，出蓝图、物流站存储时用 realItem 换回真实编号。
 */
export const BYPRODUCT = 100000;
export const realItem = (id) => (id >= BYPRODUCT ? id - BYPRODUCT : id);
/**
 * 火力发电厂（用户 2026/10/07：多余副产物就地烧掉）。BWIKI「火力发电厂」「燃料」两页（2026/10/07 查）：满负荷发电 2.16 MW，
 * 基础热效率 80%，所以每秒烧掉 2.7 MJ 的燃料；燃料喷增产剂能把效率提到 100%（烧得更慢，就地烧掉不喷）。
 * 只按电网要多少电来烧：电网用不完它的发电量时它少烧，燃料会堆起来。
 */
export const THERMAL_PLANT = 2204;
export const THERMAL_MW = 2.16;
export const THERMAL_FUEL_MW = 2.7;
/** 燃料值（MJ / 个），同上 BWIKI 燃料页 */
export const FUEL_MJ = { 1120: 9, 1121: 9, 1123: 0.096, 1109: 6.75, 1114: 4.5, 1011: 4.8, 1112: 0.9, 1124: 0.084, 1117: 1.8, 1007: 4.05, 1006: 2.7 };
/** 满负荷时每分钟烧掉多少个 */
export const burnPerMinute = (itemId) => (FUEL_MJ[realItem(itemId)] ? (60 * THERMAL_FUEL_MW) / FUEL_MJ[realItem(itemId)] : 0);
/**
 * 一排火力发电厂的摆法：照用户 2026/10/07 贴来的蓝图原样（两列各 5 台，test/fixtures/ref-thermal-bank.bp.txt）。
 * 发电厂朝东（yaw 90），一列竖着隔 4 格，列与列隔 8 格；最上面一台中心在进料带下方 3 格。
 * 进料带上两根集装分拣器（列中心那格和右边那格，长 1）送进最上面一台的 1、0 号口；
 * 往下每两台之间两根集装分拣器从上面一台的 3、4 号口取、送进下面一台的 1、0 号口。
 * slot：朝东时各槽位落点相对发电厂中心的偏移（蓝图里量的）；box：朝东时碰撞体的中心偏移和宽高，蓝图里没量，
 * 按「列隔 8、台隔 4、进料带在中心上方 3 格都不撞」反推的保守估计（推断）。
 */
export const THERMAL_BANK = {
  pitchX: 8,
  pitchY: 4,
  plantDx: 3, // 列里发电厂中心在这一列起点右边几格（列宽 8：左 3、右 4）
  feedDy: 3, // 最上面一台中心在进料带下方几格
  laneDx: 4, // 列与列之间那条缝（发电厂中心右边 4 格那一列）：接电力感应塔时塔放这里（推断：按 box 估计碰撞体到 +3.43，下一列到 +5.43）
  sorterRate: 10, // 集装分拣器搬 1 格每秒往返 10 次、从建筑里取每次 1 个（BWIKI），一处两根就是每秒 20 个：一列最多串几台看它
  substationDepth: 5, // 接卫星配电站时一列最多几台：配电站 3×3 塞不进缝，只能在这一块外面，覆盖半径约 21 格
  yaw: 90,
  modelIndex: 54,
  slot: { 1: [0, 1.6854], 0: [0.8601, 1.6862], 3: [0, -0.6916], 4: [0.8655, -0.6908] },
  // 碰撞框（2026/10/08 验证合集 R 组实测）：两台左右中心隔 7 能放、隔 6 撞；上下隔 4 能放、隔 3 撞；电力感应塔在左右 3 格撞、4 格能放
  // → 横向 6.5、竖向 3.5，不偏（以前按用户蓝图反推的 6 × 3.4、往右偏 0.43 是估计）。框往上挪半格仍是推断（上下只测了对称的两台）
  box: { dx: 0, dy: 0.5, w: 6.5, h: 3.5 },
};
const isSupported = (r) => r.factories.some((f) => FACTORY_GEOMETRY[FACTORY_KIND[f]]?.supported);
/**
 * 计算器默认用哪个配方做这种物品：编号最小的单产物配方（和以前一样，不管工厂排不排得了）；
 * 没有单产物配方时，才用「这种物品是第一个产物、工厂排得了、原料里没有它自己」的带副产物配方（比如反物质只能用质能储存，同时出氢）。
 * 都没有就是原料（从边缘或物流站进）。
 */
export function defaultRecipe(itemId) {
  const all = recipesProducing(itemId).filter((r) => r.type !== -1 && r.outputs[0].id === itemId).sort((a, b) => a.id - b.id);
  return all.find((r) => r.outputs.length === 1) ?? all.find((r) => isSupported(r) && !r.inputs.some((x) => x.id === itemId)) ?? null;
}
/**
 * 一种物品可选的配方：类型不是「无中生有」、这种物品是第一个产物、工厂能排、原料里没有它自己。
 * 第一个是默认配方（编号最小的单产物配方），其余是「新配方」（高效、原始等）。
 */
export function recipeChoices(itemId) {
  const all = recipesProducing(itemId)
    .filter((r) => r.type !== -1 && r.outputs[0].id === itemId && !r.inputs.some((x) => x.id === itemId) && isSupported(r))
    .sort((a, b) => a.id - b.id);
  const def = all.find((r) => r.outputs.length === 1) ?? all[0] ?? null; // 没有单产物配方时（反物质），带副产物的就是默认
  return def ? [def, ...all.filter((r) => r !== def)] : [];
}
export const BELT_IDS = { 1: 2001, 2: 2002, 3: 2003 };
/** 单层（不堆叠）传送带运力，个/秒 */
export const BELT_SPEED = { 1: 6, 2: 12, 3: 30 };
