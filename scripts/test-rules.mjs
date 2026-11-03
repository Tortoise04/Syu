// M2a-B 规则层自测：node scripts/test-rules.mjs（退出码 0 = 全通过）
import {
  normalize,
  scan,
  topRule,
  extractMessage,
  isExempt,
  isGameContextOnly,
  isCasualCaoTalk,
  RingBuffer,
} from '../src/guard/rules.ts';

let passed = 0;
const failures = [];
const groupCount = new Map();
let currentGroup = 0;

function group(no, name) {
  currentGroup = no;
  groupCount.set(no, { name, ok: 0, fail: 0 });
}

function ok(cond, label) {
  const g = groupCount.get(currentGroup);
  if (cond) {
    passed += 1;
    if (g) g.ok += 1;
    return true;
  }
  failures.push(label);
  if (g) g.fail += 1;
  console.error('FAIL ' + label);
  return false;
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return ok(a === e, label + ' 期望 ' + e + ' 实际 ' + a);
}

function throws(fn, needle, label) {
  try {
    fn();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    return ok(needle === undefined || msg.includes(needle), label + ' 抛错信息：' + msg);
  }
  return ok(false, label + ' 期望抛错但没抛');
}

// ---------------------------------------------------------------- 词表（v0.2 定稿）
const table = {
  redline: ['冰毒', '海洛因', '大麻交易', '杀猪盘', '跑分', '洗钱', '毒品', '吸毒', '贩毒', '约炮', '福利姬', '军火', '炸药'],
  rules: {
    R3: ['猎奇', '肢解', '虐杀', '血腥', '女拳', '男拳', '时政', '政治', '键政'],
    R4: ['造谣', '抹黑', '带节奏', '引战', '拉踩', '人身攻击', '广告', '加群', '代练', '代充', '出号', '收号', '出售', '二维码'],
    R6: ['营销号', '公众号', '速看', '不看后悔'],
    R7: ['露点', '裸照', '无码', '黄图', '色图', '涩图'],
    R8: ['家产', '几套房', '家里有矿', '月薪多少', '工资多少', '收入多少', '存款多少', '房贷多少', '车贷多少', '年薪多少'],
    R9: ['bhhs'],
    R11: ['esu', '恶俗'],
  },
  recordOnly: ['出号', '收号', '代练', '代充'],
};
const wl = ['bilibili.com', 'b23.tv', 'miyoushe.com'];
const wlOpts = { linkWhitelist: wl };

// ---------------------------------------------------------------- 1) 全角/半角/空格缺口
group(1, '关键词：全角半角 + 空格缺口');
{
  const full = scan('ｂｈｈｓ', table, wlOpts);
  eq(full.hits.length, 1, '1a 全角ｂｈｈｓ 命中 1 条');
  eq(full.hits[0]?.rule, 'R9', '1b 全角命中条款 R9');
  eq(full.hits[0]?.kind, 'rule', '1c 全角命中 kind=rule');
  const half = scan('bhhs', table, wlOpts);
  eq(half.hits.length, 1, '1d 半角 bhhs 命中 1 条');
  eq(half.hits[0]?.rule, 'R9', '1e 半角命中条款 R9');
  const spaced = scan('B H H S', table, wlOpts);
  eq(spaced.hits.length, 0, '1f v1 缺口：B H H S 带空格不命中');
  eq(spaced.mustJudge, false, '1g 不命中即无送审');
}

// ---------------------------------------------------------------- 2) 交易词只记录 / 红线必判
group(2, 'recordOnly 与 redline');
{
  const trade = scan('出号', table, wlOpts);
  eq(trade.hits.length, 1, '2a 出号命中 1 条');
  eq(trade.hits[0]?.kind, 'rule', '2b 出号 kind=rule');
  eq(trade.hits[0]?.mustJudge, false, '2c 出号不送审');
  eq(trade.mustJudge, false, '2d 出号整条不送审');
  const trade2 = scan('代练', table, wlOpts); // 同时在 R4 与 recordOnly 里，recordOnly 必须先赢
  eq(trade2.hits.length, 1, '2e 代练同词只留一条');
  eq(trade2.hits[0]?.mustJudge, false, '2f 代练被 recordOnly 覆盖为不送审');
  const red = scan('冰毒', table, wlOpts);
  eq(red.hits.length, 1, '2g 冰毒命中 1 条');
  eq(red.hits[0]?.kind, 'redline', '2h 冰毒 kind=redline');
  eq(red.hits[0]?.rule, 'REDLINE', '2i 冰毒条款 REDLINE');
  eq(red.mustJudge, true, '2j 冰毒必判');
  eq(topRule(red.hits).severitySeed, 3, '2k 红线 severitySeed=3');
}

// ---------------------------------------------------------------- 3) 至少双字是硬断言
group(3, '至少双字');
{
  throws(() => scan('广告', { redline: ['毒'], rules: {}, recordOnly: [] }, wlOpts), '毒', '3a 红线表单字抛错并指出词');
  throws(() => scan('广告', { redline: [], rules: { R3: ['血'] }, recordOnly: [] }, wlOpts), '血', '3b 条款表单字抛错并指出词');
  throws(() => scan('广告', { redline: [], rules: {}, recordOnly: [''] }, wlOpts), '不满足至少双字', '3c 空串抛错');
  throws(() => scan('广告', { redline: [], rules: { R99: ['测试'] }, recordOnly: [] }, wlOpts), 'R99', '3d 非法条款键抛错');
}

// ---------------------------------------------------------------- 4) 链接与白名单
group(4, '链接白名单');
{
  const a = scan('https://www.bilibili.com/video/BV1xx', table, wlOpts);
  eq(a.hasLink, true, '4a 白名单链接 hasLink=true');
  eq(a.mustJudge, false, '4b 白名单链接不送审');
  eq(a.linkHosts, ['www.bilibili.com'], '4c 记录 host');
  eq(a.hits.length, 0, '4d 白名单链接不产生命中');
  const b = scan('https://bit.ly/abc', table, wlOpts);
  eq(b.mustJudge, true, '4e bit.ly 必判');
  eq(b.hits[0]?.kind, 'link', '4f 链接命中 kind=link');
  const c = scan('https://bilibili.com.evil.cn/x', table, wlOpts);
  eq(c.mustJudge, true, '4g bilibili.com.evil.cn 不算子域，必判');
  const d = scan('白名单 https://www.bilibili.com/a 和 https://bit.ly/abc', table, wlOpts);
  eq(d.hasLink, true, '4h 混合行 hasLink=true');
  eq(d.mustJudge, true, '4i 混一条非白名单即必判');
  const e = scan('看 www.bilibili.com/video/BV1 就行', table, wlOpts);
  eq(e.hasLink, true, '4j 裸域名也算链接');
  eq(e.mustJudge, false, '4k 裸白名单域名不送审');
  const f = scan('https://b23.tv/abc123 和 https://space.miyoushe.com/x', table, wlOpts);
  eq(f.hasLink, true, '4l b23.tv/miyoushe 子域均识别');
  eq(f.mustJudge, false, '4m b23.tv 与 miyoushe 子域都在白名单');
  const g = scan('https://x.com/a 和 https://y.com/b', table, wlOpts);
  eq(g.hits.length, 2, '4n 两个非白名单域各一条命中');
}

// ---------------------------------------------------------------- 5) 多命中合并
group(5, '多命中合并一次送审');
{
  const s = scan('广告 拉踩 二维码', table, wlOpts);
  eq(s.hits.length, 3, '5a 三词合并在一次 scan 里');
  eq(s.hits.map((h) => h.word), ['广告', '拉踩', '二维码'], '5b 按出现位置排序');
  eq(s.hits.every((h) => h.rule === 'R4'), true, '5c 全落 R4');
  eq(s.mustJudge, true, '5d 需要送审');
  eq(topRule(s.hits), { rule: 'R4', severitySeed: 2 }, '5e topRule 取 R4/2');
  const mixed = scan('广告 冰毒 女拳', table, wlOpts);
  eq(mixed.hits.length, 3, '5f 跨条款三词也只一次 scan');
  eq(topRule(mixed.hits).rule, 'REDLINE', '5g 混合时 topRule 取红线');
  const dup = scan('广告广告广告', table, wlOpts);
  eq(dup.hits.length, 1, '5h 重复出现的同词只留一条');
  eq(topRule([]), { rule: 'OTHER', severitySeed: 0 }, '5i 空 hits 给 OTHER/0');
}

// ---------------------------------------------------------------- 6) extractMessage
group(6, 'extractMessage');
{
  const s1 = extractMessage('Hello 广告');
  eq(s1.text, 'hello 广告', '6a 字符串消息归一化');
  eq(s1.images, [], '6b 字符串消息无图片');

  const s2 = extractMessage([
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'http://x/1.png' } },
  ]);
  eq(s2.images.length, 1, '6c text+image 段 images 长度 1');
  eq(s2.images[0], 'http://x/1.png', '6d 图片 url 取出');
  ok(s2.text.includes('[image]'), '6e text 里是 [image] 占位，实际：' + s2.text);

  const s3 = extractMessage([
    { type: 'reply', data: { id: '12345' } },
    { type: 'text', data: { text: '翻旧账' } },
  ]);
  eq(s3.replyId, 12345, '6f reply 段拿到 replyId（数字）');

  const cardJson = JSON.stringify({
    prompt: '限时活动 广告',
    meta: { detail_1: { title: '出售账号', desc: '代练上分' } },
  });
  const s4 = extractMessage([{ type: 'json', data: { data: cardJson } }]);
  eq(s4.cardTitle, '出售账号', '6g json 卡片段拿到 cardTitle');
  ok(s4.text.includes('广告'), '6h 卡片 prompt 进入可匹配文本，实际：' + s4.text);
  eq(scan(s4.text, table, wlOpts).hits.some((h) => h.word === '广告'), true, '6i 卡片文字能被 scan 命中');

  const s5 = extractMessage('[CQ:reply,id=777][CQ:image,file=a.jpg,url=http://x/a.jpg]看这个');
  eq(s5.replyId, 777, '6j CQ 字符串 reply 取到 id');
  eq(s5.images, ['http://x/a.jpg'], '6k CQ 字符串 image 取到 url');
  ok(s5.text.includes('[image]'), '6l CQ 字符串 image 也留占位');

  const s6 = extractMessage('', '[CQ:image,file=b.png]');
  eq(s6.images, ['b.png'], '6m 空 message 时回退 raw_message');
}

// ---------------------------------------------------------------- 7) 豁免
group(7, 'isExempt 四路 + 普通用户');
{
  const base = {
    post_type: 'message',
    message_type: 'group',
    time: 1700000000,
    self_id: 100,
    message_id: 1,
    user_id: 8,
    group_id: 9,
    message: 'hi',
    sender: { user_id: 8, nickname: 'n', role: 'member' },
  };
  eq(isExempt({ ...base, user_id: 100, sender: { user_id: 100, nickname: 'me', role: 'member' } }, { selfId: 100, ownerQq: 42 }), true, '7a selfId 豁免');
  eq(isExempt({ ...base, user_id: 42, sender: { user_id: 42, nickname: 'o', role: 'member' } }, { selfId: 100, ownerQq: 42 }), true, '7b ownerQq 豁免');
  eq(isExempt({ ...base, user_id: 8, sender: { user_id: 8, nickname: 'a', role: 'admin' } }, { selfId: 100, ownerQq: 42 }), true, '7c role=admin 豁免');
  eq(isExempt(base, { selfId: 100, ownerQq: 42, adminIds: [8] }), true, '7d adminIds 豁免');
  eq(isExempt(base, { selfId: 100, ownerQq: 42, adminIds: [7] }), false, '7e 普通用户不豁免');
  // 方案 §14.2：按群绑定者只在绑定的群豁免，别的群照判
  eq(isExempt({ ...base, user_id: 55, sender: { user_id: 55, nickname: 'b', role: 'member' } }, { selfId: 100, ownerQq: 42, groupOwners: { 9: [55] } }), true, '7f 群绑定者在绑定群豁免');
  eq(isExempt({ ...base, group_id: 7, user_id: 55, sender: { user_id: 55, nickname: 'b', role: 'member' } }, { selfId: 100, ownerQq: 42, groupOwners: { 9: [55] } }), false, '7g 群绑定者在别的群不豁免');
  eq(isExempt(base, { selfId: 100, ownerQq: 42, groupOwners: undefined }), false, '7h groupOwners 缺省与旧口径一致');
  // 不检测名单（2026-11-02）：名单里的人说话不判；空名单不改变任何行为
  eq(isExempt({ ...base, user_id: 66, sender: { user_id: 66, nickname: 'w', role: 'member' } }, { selfId: 100, ownerQq: 42, whitelist: [66] }), true, '7i 不检测名单豁免');
  eq(isExempt({ ...base, user_id: 66, sender: { user_id: 66, nickname: 'w', role: 'member' } }, { selfId: 100, ownerQq: 42, whitelist: [67] }), false, '7j 不在名单里照判');
  eq(isExempt(base, { selfId: 100, ownerQq: 42 }), false, '7k whitelist 缺省与旧口径一致');
}

// ---------------------------------------------------------------- 8) RingBuffer
group(8, 'RingBuffer');
{
  const rb = new RingBuffer(5);
  for (let i = 1; i <= 10; i += 1) {
    rb.push({ messageId: i, userId: 1, nickname: 'u', time: 1000 + i, text: String(i), images: [], isTarget: false });
  }
  eq(rb.size, 5, '8a 推 10 条后 size=5');
  eq(rb.snapshot()[0].messageId, 6, '8b 最旧的 1..5 被丢');
  eq(rb.snapshot()[4].messageId, 10, '8c 最新一条在尾部');
  const mid = rb.around(8, 2, 2);
  eq(mid.map((x) => x.messageId), [6, 7, 8, 9, 10], '8d around 中间条前后各 2 且含自身');
  eq(mid.map((x) => x.time), [1006, 1007, 1008, 1009, 1010], '8e around 按 time 升序');
  eq(rb.around(999, 2, 2), [], '8f around 不存在的 id 返回 []');
  eq(rb.recent(2).map((x) => x.messageId), [9, 10], '8g recent(2) 取最近两条');

  const rb2 = new RingBuffer(10);
  const times = [3, 1, 2, 5, 4];
  for (let i = 0; i < times.length; i += 1) {
    rb2.push({ messageId: i + 1, userId: 1, nickname: 'u', time: times[i], text: '', images: [], isTarget: false });
  }
  eq(rb2.around(3, 5, 5).map((x) => x.time), [1, 2, 3, 4, 5], '8h 乱序 time 也被排成升序');
  throws(() => new RingBuffer(0), 'cap', '8i cap=0 抛错');
}

// ---------------------------------------------------------------- 9) 归一化三条
group(9, '归一化');
{
  eq(normalize('　全角　空格　'), '全角 空格', '9a 全角空格 + 首尾空白折叠');
  eq(normalize('a   b\t\nc'), 'a b c', '9b 连续空白折叠成一个空格');
  eq(normalize('ＢＨＨＳ ABC'), 'bhhs abc', '9c 全角转半角并小写');
  eq(scan('　广告　', table, wlOpts).hits.length, 1, '9d 空白折叠不影响命中');
}

// ---------------------------------------------------------------- 10) v1 边界：不做繁简
group(10, 'v1 边界：不做繁简转换');
{
  eq(normalize('測試'), '測試', '10a 繁体保持原样');
  eq(normalize('测试'), '测试', '10b 简体保持原样');
  ok(normalize('測試') !== '测试', '10c 繁简不同形不同字，v1 不互转');
}

// ---------------------------------------------------------------- 11) gated 档
group(11, 'gated 词：本地确认档');
{
  const t = {
    redline: [],
    alarm: ['炸群'],
    softAlarm: ['撤一下'],
    rules: { R4: ['刷单'], R11: [] },
    hints: { R4: ['广告'] },
    gated: { R3: ['731', '垃圾'], R4: [] },
    recordOnly: ['出号'],
  };
  const g = scan('731 年建的楼', t, wlOpts);
  eq(g.hits.length, 1, '11a 731 命中 1 条');
  eq(g.hits[0]?.kind, 'gated', '11b kind=gated');
  eq(g.hits[0]?.mustJudge, false, '11c gated 不直通云');
  eq(g.hasGated, true, '11d hasGated=true');
  eq(g.hasHint, false, '11e 不算 hint');
  eq(g.mustJudge, false, '11f 整条不直通云');

  // 同一个词同时写在 rules（直通云）与 gated：直通云赢
  const both = { redline: [], rules: { R3: ['731'] }, hints: {}, gated: { R3: ['731'] }, recordOnly: [] };
  const b = scan('731', both, wlOpts);
  eq(b.hits.length, 1, '11g 同词只留一条');
  eq(b.hits[0]?.kind, 'rule', '11h 直通云优先于 gated');
  eq(b.mustJudge, true, '11i 直通云必判');

  // gated 与 hint 同行：两个标记都要真，调用方按 gated 先走
  const mixed = scan('731 广告', t, wlOpts);
  eq(mixed.hasGated, true, '11j 混合命中 hasGated');
  eq(mixed.hasHint, true, '11k 混合命中 hasHint');

  // 非法键报错
  throws(() => scan('731', { redline: [], rules: {}, hints: {}, gated: { R99: ['测试'] }, recordOnly: [] }, wlOpts), 'R99', '11l gated 非法条款键抛错');
}

// ---------------------------------------------------------------- 12 游戏语境 vs 开盒
// 2026-11-03 用户拍板 C 方案：含游戏词且不含开盒要素词才算游戏语境
group(12, 'R11 游戏语境判别');
eq(isGameContextOnly('[at:10001] box发来 申请会诊'), true, '12a box发来 申请会诊 → 游戏语境');
eq(isGameContextOnly('发box看看你的角色池 帮我看号'), true, '12b 发box看角色池 → 游戏语境');
eq(isGameContextOnly('box发来 顺便把你真名和住址发我'), false, '12c box + 真名住址 → 不算游戏语境');
eq(isGameContextOnly('非要恶俗大手子满地跑,才晓得要维护环境'), false, '12d 没有游戏词 → 不算游戏语境');
eq(isGameContextOnly('我要挂人社工库查他'), false, '12e 社工库/挂人 → 不算游戏语境');
eq(isGameContextOnly('会诊 esu 大手子'), false, '12f 游戏词夹 esu/大手子 → 不算游戏语境');
eq(isGameContextOnly('box发来 满命专武 帮看配队'), true, '12g 游戏词组合 → 游戏语境');

// ---------------------------------------------------------------- 13 「艹」类口头语
// 2026-11-03 用户拍板：群友相互草可以，草死都可以；操你妈/草泥全家/草拟吗 这种不行
group(13, '「艹」类口头语');
eq(isCasualCaoTalk('草饲我'), true, '13a 草饲我 → 口头语');
eq(isCasualCaoTalk('草死你'), true, '13b 草死你 → 玩笑');
eq(isCasualCaoTalk('xx来草我'), true, '13c xx来草我 → 玩笑');
eq(isCasualCaoTalk('我草xx'), true, '13d 我草xx → 玩笑');
eq(isCasualCaoTalk('所有人来艹我'), true, '13e 所有人来艹我 → 口头语');
eq(isCasualCaoTalk('[at:10001] 我艹死你'), true, '13f @ 了人也是玩笑');
eq(isCasualCaoTalk('操你妈'), false, '13g 操你妈 → 照判');
eq(isCasualCaoTalk('草拟吗'), false, '13h 草拟吗 → 照判');
eq(isCasualCaoTalk('草泥全家'), false, '13i 草泥全家 → 照判');
eq(isCasualCaoTalk('曹死你吗'), false, '13j 曹死你吗 → 照判');
eq(isCasualCaoTalk('草泥马'), false, '13k 草泥马 → 照判');
eq(isCasualCaoTalk('操你m'), false, '13l 操你m（字母规避）→ 照判');
eq(isCasualCaoTalk('操你ma'), false, '13m 操你ma（字母规避）→ 照判');
eq(isCasualCaoTalk('草你m'), false, '13n 草你m（字母规避）→ 照判');
eq(isCasualCaoTalk('今天打深渊真的好累啊打了三个小时还没过然后所有人都来艹我'), true, '13o 长句里的口头语 → 也算');

// ---------------------------------------------------------------- 汇总
console.log('');
console.log('--- 13 组验收 ---');
for (const [no, g] of [...groupCount.entries()].sort((a, b) => a[0] - b[0])) {
  console.log('[' + String(no).padStart(2, ' ') + '] ' + (g.fail === 0 ? 'PASS' : 'FAIL') + '  ' + g.name);
}
console.log('');
if (failures.length === 0) {
  console.log('全部通过：' + passed + ' 条断言');
  process.exit(0);
} else {
  console.error('失败 ' + failures.length + ' 条，通过 ' + passed + ' 条');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
