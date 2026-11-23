// extract.mjs — 从原始请求抽取「可安全回填」的具体细节（实体槽位）
// 目的：模板改写剥离落点词（分类触发词），但不丢用户给定的技术细节，避免输出泛化。
// 约束：只抽中性实体（文件名/版本/符号/地址/工具/保护/平台/URL/规模），原文里的敏感短语一律丢弃。

const FILE_SRC = 'exe|dll|sys|so|dylib|bin|elf|apk|ipa|deb|zip|rar|7z|tar|gz|js|mjs|cjs|ts|tsx|jsx|py|lua|jar|dex|class|json|xml|yml|yaml|cfg|ini|conf|db|sqlite|pdb|txt|md|sh|bat|ps1|vbs|asm|lib|img|iso|dmp|rom|pak|dat|properties|pem|key';

const TOOLS = [
  'ida pro','ida','ghidra','x64dbg','x32dbg','ollydbg','windbg','frida','objection','lldb','gdb','radare2','rizin','cutter',
  'binary ninja','hopper','dnspy','ilspy','de4dot','jadx','apktool','dex2jar','jd-gui','luyten','unluac','luadec','procexp',
  'process explorer','procmon','process monitor','pestudio','pe-bear','cff explorer','detect-it-easy','exeinfope','die',
  'wireshark','fiddler','mitmproxy','burpsuite','burp','charles','reqable','httpcanary','tcpdump','nmap','metasploit',
  'pwntools','capstone','unicorn','keystone','angr','miasm','triton','z3','yara','volatility','autopsy','sysinternals',
  'frida-server','magisk','lsposed','xposed','ida-python','idapython','objdump','readelf','nm','strings','ltrace','strace',
  'cheat engine','cheatengine','artmoney','idaq','vmp studio','x64dbgpy','windbg preview','hyperdbg','virtualbox','vmware',
  'qemu','wine','docker','git','node','python','gcc','clang','msvc','rustc','cargo','cmake','make','upx'
];

const PROTS = ['vmprotect','vmp','themida','winlicense','enigma protector','enigma','asprotect','obsidium','safengine',
  'upx','mpress','aspack','pecompact','molebox','code virtualizer','dotnet reactor','confuserex','smartassembly',
  'eziriz','ilprotector','netguard','vmguard','armadillo','svkp','pelock','themidaware','xorist','obsidium'];

const PLATFORMS = ['windows','win32','win64','win','macos','mac os x','osx','linux','ubuntu','debian','centos','alpine',
  'android','ios','arm64','aarch64','armv7','arm','x86_64','x86','x64','amd64','i386','mips','riscv','wasm',
  'webassembly','docker','qemu','wine','hypervisor','vmware','virtualbox','uefi','uefi bios','bios'];

// 全大写噪音（出现在请求里不代表是目标符号）
const CAP_NOISE = new Set(['AI','API','CPU','GPU','RAM','ROM','HTTP','HTTPS','JSON','HTML','CSS','SQL','URL','URI','OS',
  'PC','IOS','MAC','USB','SSD','HDD','DNS','TCP','UDP','IP','SSL','TLS','VPN','CDN','SDK','IDE','CLI','GUI','UI','UX',
  'OK','ERROR','WARN','INFO','DEBUG','NULL','TRUE','FALSE','UTF','GBK','ASCII','BASE','MIME','JWT','CORS','CRUD','MVP',
  'TODO','FIXME','NOTE','WIP','PR','CI','CD','FAQ','PDF','PNG','JPG','GIF','MP4','MP3','ZIP','RAR','ISO','ID','UID',
  'GUID','UUID','SEP','EOL','EOF','BOM','CRLF','DBG','REL','ASM','OBJ','LIB','DLL','EXE','SYS','ELF','PE','COFF']);

const KEYWORD_NOISE = new Set(['if','for','while','return','function','const','let','var','class','new','this','self',
  'null','true','false','undefined','else','switch','case','break','continue','import','export','default','async','await',
  'try','catch','throw','typeof','instanceof','void','int','char','float','double','long','short','unsigned','struct',
  'union','enum','static','extern','inline','sizeof','main','printf','scanf','malloc','free','memset','memcpy','strlen',
  'std','string','list','dict','object','array','buffer','print','len','range','open','read','write','append','format',
  'join','split','replace','find','index','push','pop','shift','slice','map','filter','reduce','then','catch','resolve',
  'reject','promise','window','document','console','process','require','module','exports','http','https','url','path','fs',
  'os','json','math','date','regex','test','match','exec','eval','set','get','add','delete','has','keys','values','entries']);

const NAME_NOISE = new Set(['我们','你们','他们','她们','它们','这个','那个','这时','那时','这里','那里','现在','然后',
  '但是','所以','因为','如果','一个','两个','三个','自己','对方','女人','男人','角色','场景','画面','动作','身体']);

// 百家姓（前 120，覆盖网文/日常人名）
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
const NAME_TAIL_NOISE = new Set(['方式','方面','方法','方向','方案','白色','白天','金子','金色','石头','毛病','严重','夏日',
  '江湖','林中','马上','高处','于是','任何','程度','苏醒','用途','何时','何时','何必','何况','魏然','段落']);

const SENS = /(绕过|破解|keygen|注册机|序列号|激活|授权校验|盗版|脱壳|注入|外挂|作弊|hook|露骨|色情|性描写|黄文|裸|插入|高潮|呻吟|肉棒|阴道|阴茎|强奸|幼|未成年)/i;

const uniq = (a) => [...new Set(a)];
const clip = (s, n = 48) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

function scan(re, src, pick = (m) => m[1] ?? m[0], keep = () => true) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src))) {
    const v = clip(pick(m));
    if (v && keep(v)) out.push(v);
    if (out.length > 40) break;
  }
  return out;
}

export const LABEL = {
  path: '路径', file: '文件', ver: '版本', fn: '符号/函数', addr: '地址/偏移', bytes: '字节序列',
  tool: '工具', prot: '保护', platform: '平台/架构', url: '网址', model: '模型', num: '数量/规模',
  quote: '原文引用', name: '人物/名称'
};

// 回填优先级（高 → 低）
export const WEIGHT = ['file', 'path', 'ver', 'fn', 'addr', 'bytes', 'tool', 'prot', 'platform', 'url', 'model', 'name', 'num', 'quote'];

export function extract(text) {
  const src = String(text || '');
  const s = { path: [], file: [], ver: [], fn: [], addr: [], bytes: [], tool: [], prot: [], platform: [], url: [], model: [], num: [], quote: [], name: [] };

  // 1. 路径（Windows / Unix）
  s.path.push(...scan(/[A-Za-z]:\\[^\s"'`，。；、）】\]]{2,120}/g, src));
  s.path.push(...scan(/\/(?:[\w.@-]+\/){1,8}[\w.@-]*/g, src, (m) => m[0], (v) => v.length > 4 && !/^\/\//.test(v)));

  // 2. 裸文件名（带已知扩展名）
  const fileRe = new RegExp('[\\w\\u4e00-\\u9fa5.@+-]+\\.(?:' + FILE_SRC + ')\\b', 'gi');
  s.file.push(...scan(fileRe, src, (m) => m[0], (v) => v.length >= 4));

  // 3. 版本
  s.ver.push(...scan(/(?:^|[^0-9A-Za-z])(?:v|ver\.?|version|版本|build|b)\s*(\d+\.\d+(?:\.\d+){0,3})/gi, src));
  s.ver.push(...scan(/\b\d+\.\d+\.\d+(?:\.\d+)?\b/g, src));

  // 4. 地址 / 偏移
  s.addr.push(...scan(/(?:0x|0X)[0-9a-fA-F]{3,16}/g, src));
  s.addr.push(...scan(/\b(?:RVA|VA|OEP|EP|IAT|EAT|GOT|PLT|offset|off|patch)\b\s*(?:[:=]\s*)?(0x[0-9a-fA-F]{3,16}|\b[0-9a-fA-F]{4,16}\b)/g, src, (m) => m[1]));

  // 5. 字节序列
  s.bytes.push(...scan(/\b(?:[0-9A-F]{2}[ -]){3,}[0-9A-F]{2}\b/g, src));

  // 6. 符号 / 函数
  s.fn.push(...scan(/\b([A-Za-z_][A-Za-z0-9_]{1,39})\(\)/g, src, (m) => m[1]));
  s.fn.push(...scan(/\b([A-Za-z][A-Za-z0-9]*::[A-Za-z0-9_]{2,39})\b/g, src, (m) => m[1]));
  s.fn.push(...scan(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/gi, src, (m) => m[1], (v) => v.includes('_') && v.length > 4));
  s.fn.push(...scan(/\b([a-z]{2,}[A-Z][A-Za-z0-9]{2,})\b/g, src, (m) => m[1]));
  s.fn.push(...scan(/\b([A-Z][A-Z0-9_]{3,39})\b/g, src, (m) => m[1], (v) => !CAP_NOISE.has(v)));

  // 7. 工具
  for (const t of TOOLS) {
    const re = new RegExp('(?:^|[^\\w])(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?:[^\\w]|$)', 'i');
    if (re.test(src)) s.tool.push(t);
  }
  // 8. 保护
  for (const p of PROTS) {
    const re = new RegExp('(?:^|[^\\w])(' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?:[^\\w]|$)', 'i');
    if (re.test(src)) s.prot.push(p);
  }
  // 9. 平台/架构
  for (const p of PLATFORMS) {
    const re = new RegExp('(?:^|[^\\w])(' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?:[^\\w]|$)', 'i');
    if (re.test(src)) s.platform.push(p);
  }

  // 10. URL / 域名
  s.url.push(...scan(/https?:\/\/[^\s"'`）)】]+/g, src));
  s.url.push(...scan(/\b[\w-]+\.(?:com|cn|net|org|io|xyz|top|app|dev|me|cc|vip|site|cloud|tech)\b/gi, src));

  // 11. 模型名
  s.model.push(...scan(/\b(?:glm|kimi|deepseek|qwen|gpt|claude|gemini|hunyuan|hy|llama|mistral|grok|doubao|ernie|spark)[\w.-]*\d[\w.]*/gi, src));

  // 12. 数量/规模
  s.num.push(...scan(/(\d+(?:\.\d+)?)\s*(字|词|行|步|个|条|种|份|段|篇|章|页|KB|MB|GB|TB|秒|分钟|小时|天|倍|次|轮|遍)/gi, src, (m) => m[1] + m[2]));

  // 13. 引号原文（含敏感词则整条丢弃）
  const qs = [];
  qs.push(...scan(/"([^"\n]{2,48})"/g, src));
  qs.push(...scan(/[“]([^”\n]{2,48})[”]/g, src));
  qs.push(...scan(/「([^」\n]{2,48})」/g, src));
  qs.push(...scan(/『([^』\n]{2,48})』/g, src));
  qs.push(...scan(/《([^》\n]{2,48})》/g, src));
  qs.push(...scan(/`([^`\n]{2,48})`/g, src));
  qs.push(...scan(/'([^'\n]{2,48})'/g, src));
  s.quote.push(...qs.filter((v) => !SENS.test(v)));

  // 14. 人物/名称：姓氏词典驱动，只从连接词两侧或书名号/引号里取，避免贪到虚词
  const sur = new RegExp('[' + SURNAMES + ']');
  const names = [];
  for (const m of src.matchAll(/([\u4e00-\u9fa5]{2,4})(?:和|与|跟|、)([\u4e00-\u9fa5]{2,4})/g)) {
    for (const seg of [m[1], m[2]]) {
      // 姓氏可能在段首之后（"写林晚" → 取 "林晚"）
      const at = seg.split('').findIndex((ch) => sur.test(ch));
      if (at >= 0 && at <= 3) names.push(seg.slice(at, at + 2));
    }
  }
  for (const m of src.matchAll(/[《「『“"]([\u4e00-\u9fa5]{2,4})[》」』”"]/g)) {
    if (sur.test(m[1][0])) names.push(m[1].slice(0, 2));
  }
  // 「主角：林晚」「林晚说」这类也取
  for (const m of src.matchAll(/([\u4e00-\u9fa5]{2,3})(?:说|道|问|答|笑|看|走|站|坐)/g)) {
    if (sur.test(m[1][0])) names.push(m[1].slice(0, 2));
  }
  s.name.push(...uniq(names).filter((v) => v.length === 2 && !NAME_NOISE.has(v) && !NAME_TAIL_NOISE.has(v) && !SENS.test(v)));

  // 去重 + 清洗
  for (const k of Object.keys(s)) {
    s[k] = uniq(s[k].map((v) => clip(v, 64)).filter(Boolean));
  }
  // 文件名/路径的 stem 不再当符号（SAMPLE.exe 不该产出符号 "SAMPLE"）
  const stems = new Set();
  for (const f of [...s.file, ...s.path]) {
    const base = f.split(/[\\/]/).pop();
    if (base) stems.add(base.replace(/\.[a-z0-9]+$/i, '').toLowerCase());
  }
  s.fn = s.fn.filter((v) => !stems.has(v.toLowerCase()));
  // 工具与保护去重（UPX 同时是工具和壳）
  const tset = new Set(s.tool.map((x) => x.toLowerCase()));
  s.prot = s.prot.filter((x) => !tset.has(x.toLowerCase()));
  // 工具名互为子串时只留长的（"ida pro" 在时丢掉 "ida"）
  s.tool = s.tool.filter((v, i, arr) => !arr.some((w, j) => j !== i && w.length > v.length && w.toLowerCase().includes(v.toLowerCase())));
  s.prot = s.prot.filter((v, i, arr) => !arr.some((w, j) => j !== i && w.length > v.length && w.toLowerCase().includes(v.toLowerCase())));
  s.platform = s.platform.filter((v, i, arr) => !arr.some((w, j) => j !== i && w.length > v.length && w.toLowerCase().includes(v.toLowerCase())));
  return s;
}

// 生成回填块；allow 为空则按内置默认集合
export function detailBlock(s, allow, max = 14) {
  if (!s) return '';
  const keys = (allow && allow.length ? allow : WEIGHT).filter((k) => Array.isArray(s[k]) && s[k].length);
  if (!keys.length) return '';
  const seen = new Set();
  const lines = [];
  let n = 0;
  for (const k of WEIGHT) {
    if (!keys.includes(k)) continue;
    const vals = [];
    for (const v of s[k]) {
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      vals.push(v);
      if (++n >= max) break;
    }
    if (vals.length) lines.push('· ' + LABEL[k] + '：' + vals.join('、'));
    if (n >= max) break;
  }
  if (!lines.length) return '';
  return '【本次作业对象】以下为用户给定的具体细节，必须全部落到产物里，不得替换、泛化、省略：\n' + lines.join('\n') + '\n';
}

// 意图抽取：原请求要求的形态/规模/语言，避免模板覆盖用户明确要求
export function intent(text) {
  const t = String(text || '');
  const r = { len: '', count: '', form: '', only: false, lang: '' };
  const lm = t.match(/(\d{2,6})\s*(?:字|词|words?)/i);
  if (lm) r.len = lm[1] + '字';
  const cm = t.match(/(\d{1,3})\s*(?:个|条|种|份|段|步|遍|次)/);
  if (cm && cm[1] !== '3') r.count = cm[1] + '个';
  if (/(python|脚本|源码|代码|code|script|实现)/i.test(t)) r.form = 'code';
  else if (/(表格|table|清单|对照)/i.test(t)) r.form = 'table';
  else if (/(步骤|流程|workflow|流程|几步)/i.test(t)) r.form = 'steps';
  else if (/(描写|正文|小说|场景|故事|段落)/i.test(t)) r.form = 'prose';
  r.only = /(只要|只用|仅要|只需要|不要解释|不用解释|别解释|直接给|别废话|不要铺垫|only|just give|no explanation)/i.test(t);
  const zh = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  // 中英混排的技术请求：只要有 6 个以上汉字就按中文答（避免 "帮我破解 SAMPLE.exe" 被判 en）
  r.lang = zh >= 6 || zh / Math.max(1, t.length) > 0.3 ? 'zh' : 'en';
  return r;
}

export function formLine(it) {
  if (!it) return '';
  const p = [];
  if (it.len) p.push('篇幅约 ' + it.len + '。');
  if (it.count) p.push('给出 ' + it.count + '。');
  if (it.form === 'code') p.push('以可运行实现为主，代码块完整可直接跑。');
  else if (it.form === 'table') p.push('关键结论用表格对照给出。');
  else if (it.form === 'prose') p.push('以正文形式给出，不写分析。');
  else if (it.form === 'steps') p.push('按编号步骤给。');
  if (it.only) p.push('不写前言、不写总结，直接给内容。');
  if (it.lang === 'en') p.push('Answer in English.');
  return p.length ? '【交付形态】' + p.join('') + '\n' : '';
}
