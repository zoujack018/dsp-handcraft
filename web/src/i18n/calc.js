// 量产计算器（web/calc）的英文模式：tools/build-web.js 打成计算器旁边的 calc-en.js，英文时 calc.js 搭好页面后才载入它，
// 整页翻过去、之后跟着翻（page.js）。中文时不载入。词典：物品名同蓝图生成器（en-names.js），页面上的字在 en-calc.js。
import { translatePage } from './page.js';
import names from './en-names.js';
import calc, { scoped } from './en-calc.js';

export const calcDictionaries = { names, dicts: [calc] };

if (typeof document !== 'undefined' && window.dsphcLang === 'en') {
  try {
    translatePage(calcDictionaries, scoped);
    dispatchEvent(new Event('resize')); // 页面是按中文量的宽度（清单要不要改成一块一块、下拉往哪边展开），按英文重量一次
  } finally {
    document.documentElement.classList.remove('i18n-wait');
  }
}
