// 英文词典（补遗）：照着页面走一遍时补的，盖在别的几份上面。键是页面上出现的中文原文（{0}、{1} 是代进去的值），值是英文。
export default {
  // 空图纸上那句：点击 + 左侧 / 上方（样式表只显示一个）+「生成蓝图」
  '点击': 'Click ',
  '左侧': '',
  '上方': '',
  '「生成蓝图」': '"Generate blueprint"',
  '无': 'None',
  // 左栏的两格选项窄，写短
  '关（只限赤道）': 'Equator only',
  '开（任何纬度）': 'Any latitude',
  '整张一格': 'One slot',
  // 图纸上的提示、读屏用的说明
  '编号 {0}': 'No. {0}',
  '查看线路简介': 'view route details',
  '{0} 布线图': '{0} layout',
  '{0} 乘 {1} 格': '{0} by {1} cells',
  // 泛指的「传送带」「分拣器」后面跟着一级的那种（游戏里一级的就叫这两个名字）
  '传送带：传送带': 'Belt: Conveyor Belt Mk.I',
  '分拣器：分拣器': 'Sorter: Sorter Mk.I',
  // 检查里说用到了什么
  '直上直下的垂直传送带': 'vertical belts',
  '一格升一层的陡坡': 'steep slopes rising one level per cell',
  '{0}和{1}': '{0} and {1}',
  '分馏塔阵列': 'fractionator array',
  // 「接口」那张卡：整行连数字一起翻（{…} 里是数字的标签）
  '{0} {1}/分，从{2}边第 {3} {4}送入': '{0} {1}/min, in at the {2} edge, {4} {3}',
  '成品 {0} {1}/分，从{2}边第 {3} {4}出来': 'Product {0} {1}/min, out at the {2} edge, {4} {3}',
  '成品 {0} {1}/分': 'Product {0} {1}/min',
  '{0}边第 {1} {2}的{3} {4} 个': '{0} edge, {2} {1}: {3} ×{4}',
  '每个叠 {0} 层': 'each stacked {0} high',
  '装满够 {0} 分钟': 'lasts {0} min when full',
  '顶上放物流配送器（{0}）': 'Logistics Distributor on top ({0})',
  // 同一张卡，一段一段翻时用的
  '行的{0}': 'row: {0} ×',
  '列的{0}': 'column: {0} ×',
  '个，每个叠': ', each stacked',
  '层，装满够': 'high; lasts',
  '个，装满够': '; lasts',
  '副产物 {0} 单独一条带送出进储物仓 / 储液罐，满了要取走。': 'Byproduct {0} leaves on its own belt into storage / a tank; empty it when full.',
  '副产物 {0} 单独一条带送出进物流站': 'Byproduct {0} leaves on its own belt into the logistics station',
  '副产物 {0} 单独一条带送出，要接走，不然会堵。': 'Byproduct {0} leaves on its own belt; take it away or the line will jam.',
  // 后台出错时可能带出来的
  '未知物品 ID {0}': 'Unknown item ID {0}',
  '未知物品「{0}」': 'Unknown item "{0}"',
  '未知配方 ID {0}': 'Unknown recipe ID {0}',
  '未知配方「{0}」': 'Unknown recipe "{0}"',
  '未知工厂 ID {0}': 'Unknown factory ID {0}',
};

// 只在页面某一块里才这么翻的（[选择器, 词典]）：顶上一排按钮写短名，图纸标题栏的统计是复数
export const scoped = [
  [
    '.pill-text',
    {
      '普通传送带': 'Belt Mk.I',
      '高速传送带': 'Belt Mk.II',
      '极速传送带': 'Belt Mk.III',
      '普通物流': 'Belts only',
      '物流站': 'Stations',
      '不增产': 'No spray',
      'Mk.I 增产': 'Spray Mk.I',
      'Mk.II 增产': 'Spray Mk.II',
      'Mk.III 增产': 'Spray Mk.III',
      '量子化工厂': 'Quantum Chem. Plant',
      '自演化研究站': 'Self-evo Lab',
    },
  ],
  ['#sheet-stats', { '传送带': 'Belts', '分拣器': 'Sorters', '工厂': 'Factories', '格': 'cells' }],
];
