// 蓝图生成器的英文模式：页面搭好以后整页翻过去、之后跟着翻（page.js），词典是下面这几份。
// 语言在模板开头那段脚本里定（window.dsphcLang）；切换语言是记下选择、重新打开页面。
import { translatePage } from './page.js';
import names from './en-names.js';
import template from './en-template.js';
import app from './en-app.js';
import engine1 from './en-engine1.js';
import engine2 from './en-engine2.js';
import extra, { scoped } from './en-extra.js';

export const dictionaries = { names, dicts: [engine2, engine1, app, template, extra] }; // 后面的盖前面的

export function startEnglish() {
  translatePage(dictionaries, scoped);
}
