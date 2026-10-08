// 实时预览「自动」模式看哪一轮（用户 2026/10/07）：看利用率最高的那一轮，但别切得太勤——
// 盯住一轮看，除非别的轮连续领先够久才切过去；两次切换之间有个下限，任何切换都要等到下限。
// 正在看的那轮搜完了（不再报进度）先停在它最后的样子；没达标接着搜时每一段都换一批种子（快档一段只有几秒），
// 新一段接着看同一个轮号（从同一个初始排法起步），计时不清零；到了下限它还没在搜，才换到领先的那轮。
// 挑战者也按轮号跨段算：快档一段只有几秒，不跨段的话谁也领先不了 15 秒。
// 利用率是这一轮目前最好那张（搜索阶段，还没接物流站、供电）的空间利用率；最好那张不可行的排在所有可行的后面。

// 1.5 是 30 秒 / 15 秒 / 半个百分点，用户嫌还是切得勤（2026/10/07），放到 2 分钟 / 30 秒 / 1 个百分点
export const WATCH = {
  gap: 120000, // 两次切换至少隔 2 分钟
  lead: 30000, // 别的轮要连续领先 30 秒才切过去
  margin: 0.01, // 领先 1 个百分点以上才算领先，差不多的不算
  stale: 2500, // 这么久没报进度，这一轮多半已经搜完
};

const score = (r) => r.space ?? -1; // 不可行（没有利用率）排最后
/** a 比 b 好：利用率高；一样（比如都不可行）时看代价低 */
const better = (a, b) => (score(a) !== score(b) ? score(a) > score(b) : a.best < b.best);

/**
 * 返回 pick(rounds, now)：rounds 是 Map(轮号 → { t: 最近一次报进度的时刻, space, best })，返回该看哪一轮（没有就 null）。
 * 有状态：记着正在看哪轮、从什么时候开始看、谁在挑战。新一段搜索（换了一批种子）时调 newSegment(now)。
 */
export function autoWatcher(opt = WATCH) {
  let shown = null;
  let since = 0;
  let challenger = null;
  let leadSince = 0;
  let segStart = -Infinity;
  const pick = (rounds, now) => {
    let lead = null;
    for (const [s, r] of rounds) {
      if (now - r.t > opt.stale) continue;
      if (lead == null || better(r, rounds.get(lead))) lead = s;
    }
    if (lead == null) return shown;
    const cur = rounds.get(shown);
    if (shown != null && !cur && now - segStart <= opt.stale) return shown; // 新一段刚开始，正在看的轮号还没报上来，等它一下
    if (shown == null || !cur || now - cur.t > opt.stale) {
      // 正在看的那轮已经搜完：没到切换下限就停在它最后的样子；还没看任何一轮或到了下限，看领先的
      if (shown != null && now - since < opt.gap) return shown;
      shown = lead;
      since = now;
      challenger = null;
      return shown;
    }
    const r = rounds.get(lead);
    const ahead = lead !== shown && (score(r) > score(cur) + opt.margin || (score(r) === score(cur) && score(r) < 0 && r.best < cur.best * 0.98));
    if (!ahead) {
      challenger = null;
      return shown;
    }
    if (challenger !== lead) {
      challenger = lead;
      leadSince = now;
    }
    if (now - leadSince >= opt.lead && now - since >= opt.gap) {
      shown = lead;
      since = now;
      challenger = null;
    }
    return shown;
  };
  /** 新一段搜索开始：接着看同一个轮号，切换计时和挑战者都照旧（同一个轮号几段里一直领先也算领先很久） */
  pick.newSegment = (now) => {
    segStart = now;
  };
  return pick;
}

/**
 * 预览给不给看这张排法（用户 2026/10/07：长宽比过于离谱的直接不予展示）：设了宽、长上限的不能超出，设了长宽比上限的不能超出；
 * 什么上限都没设时长边不超过短边 4 倍（和规划器判「瘦长、再搜」同一个口径，plan/index.js 的 lanky）。退火刚开始常排出一长条
 */
export function previewShapeOk(m, ro = {}) {
  const { maxWidth, maxHeight, maxAspect } = ro || {};
  if ((maxWidth && m.width > maxWidth) || (maxHeight && m.height > maxHeight)) return false;
  const ratio = Math.max(m.width, m.height) / Math.max(1, Math.min(m.width, m.height));
  if (maxAspect) return ratio <= maxAspect;
  return maxWidth || maxHeight ? true : ratio <= 4;
}
