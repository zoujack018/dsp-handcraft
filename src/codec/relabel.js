// 只换蓝图字符串头里的名字和说明（建筑数据原样不动），校验码跟着重算。
// 蓝图字符串：BLUEPRINT:0,排法,图标×5,0,时间,游戏版本,名字,说明"压缩的建筑数据"校验码（名字、说明是 encodeURIComponent 过的）
import { digest } from './md5.js';

const START = 'BLUEPRINT:';
const HASH_LEN = 32;

function checksum(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return [...new Uint8Array(digest(bytes.buffer))].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

/** 蓝图字符串头里的名字和说明；不是蓝图字符串返回 null */
export function blueprintLabel(str) {
  if (typeof str !== 'string' || !str.startsWith(START)) return null;
  const end = str.indexOf('"', START.length);
  const cells = end < 0 ? [] : str.slice(START.length, end).split(',');
  if (cells.length < 12 || str[str.length - HASH_LEN - 1] !== '"') return null;
  return { shortDesc: decodeURIComponent(cells[10]), desc: decodeURIComponent(cells[11]) };
}

/** 换上新的名字、说明，返回新的蓝图字符串；不是蓝图字符串原样返回 */
export function relabelBlueprint(str, { shortDesc, desc }) {
  const old = blueprintLabel(str);
  if (!old) return str;
  const end = str.indexOf('"', START.length);
  const cells = str.slice(START.length, end).split(',');
  cells[10] = encodeURIComponent(shortDesc ?? old.shortDesc);
  cells[11] = encodeURIComponent(desc ?? old.desc);
  const body = START + cells.join(',') + str.slice(end, str.length - HASH_LEN - 1);
  return `${body}"${checksum(body)}`;
}
