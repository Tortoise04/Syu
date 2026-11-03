#!/usr/bin/env node
/**
 * 假协议端（冒充 NapCat）——M1 骨架唯一的验收手段，不需要真 QQ。
 *
 * 两种跑法：
 *   node scripts/mock-onebot.mjs           常驻：ws 冒充 NapCat，http 提供注入接口
 *   node scripts/mock-onebot.mjs --smoke   一条命令跑完六项验收，逐项打印 PASS/FAIL
 *
 * 端口：默认 ws 3002 / http 3003（3001 被 Dyu 占用）。可用 MOCK_WS_PORT / MOCK_HTTP_PORT 覆盖。
 * 注意：这台机器上 2980–3079 被 Windows「排除端口范围」占着（winnat 在跑），
 * 3002/3003 会 EACCES 绑不上，所以这里会退回 3102/3103 并打 WARN——默认值仍是 3002/3003。
 *
 * 注入（常驻模式）：
 *   curl -X POST http://127.0.0.1:<http>/test/group -H "content-type: application/json" -d "{\"text\":\"有人吗\"}"
 *   curl -X POST http://127.0.0.1:<http>/test/close -H "content-type: application/json" -d "{}"
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS_PORT = Number(process.env.MOCK_WS_PORT || 3002);
const HTTP_PORT = Number(process.env.MOCK_HTTP_PORT || 3003);
const SELF_ID = 10001;
const SELF_NAME = '守夜';
const GROUP_ID = 20001;
const USER_ID = 30001;
const NICK = '小王';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 先探一下端口能不能绑：Windows 的排除端口范围会直接 EACCES，ws 的报错不好读 */
function probePort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** 按候选顺序找第一个能绑的端口；0 = 让系统随便给一个 */
async function pickPort(preferred, fallbacks) {
  for (const port of [preferred, ...fallbacks]) {
    if (port !== 0 && !(await probePort(port))) continue;
    if (port === 0) return { port: 0, fellBack: true };
    return { port, fellBack: port !== preferred };
  }
  return { port: 0, fellBack: true };
}

function createMock({ wsPort, httpPort, silent = false } = {}) {
  const say = (...args) => {
    if (!silent) console.log('[mock]', ...args);
  };
  const state = {
    connections: 0,
    sock: null,
    sent: [],
    nextMsgId: 60000,
    connectHandlers: [],
    wsPort,
    httpPort,
  };

  const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' });

  wss.on('connection', (ws) => {
    state.connections += 1;
    state.sock = ws;
    say(`协议端已连接（第 ${state.connections} 次）`);
    for (const h of state.connectHandlers) h(state.connections);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg.action) return;
      const { action, params = {}, echo } = msg;
      let data = null;

      switch (action) {
        case 'get_login_info':
          data = { user_id: SELF_ID, nickname: SELF_NAME };
          break;
        case 'get_group_list':
          data = [{ group_id: GROUP_ID, group_name: '测试群' }];
          break;
        case 'send_group_msg':
        case 'send_private_msg': {
          const text = (params.message || [])
            .filter((s) => s.type === 'text')
            .map((s) => s.data.text)
            .join('');
          data = { message_id: ++state.nextMsgId };
          state.sent.push({ action, text, at: Date.now() });
          say(`← 机器人发出：${text}`);
          break;
        }
        case 'get_msg':
          data = { message_id: Number(params.message_id) || 0, message: [], sender: { user_id: 0, nickname: '' } };
          break;
        case 'delete_msg':
          data = {};
          break;
        default:
          data = {};
      }

      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
    });

    ws.on('close', () => {
      say('协议端断开');
      if (state.sock === ws) state.sock = null;
    });
  });

  function push(ev) {
    if (!state.sock) {
      say('没有客户端连着，换个时间再注入');
      return false;
    }
    state.sock.send(JSON.stringify(ev));
    return true;
  }

  function groupEvent({
    text,
    userId = USER_ID,
    groupId = GROUP_ID,
    messageId,
    nickname = NICK,
    postType = 'message',
    messageType = 'group',
  }) {
    const id = messageId ?? ++state.nextMsgId;
    return {
      post_type: postType,
      message_type: messageType,
      sub_type: 'normal',
      time: Math.floor(Date.now() / 1000),
      self_id: SELF_ID,
      message_id: Number(id),
      group_id: Number(groupId),
      user_id: Number(userId),
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { user_id: Number(userId), nickname, card: nickname },
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    const reply = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/test/group' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      const ev = groupEvent(body);
      push(ev);
      say(`注入群消息 #${ev.message_id}（post_type=${ev.post_type} 群${ev.group_id} 用户${ev.user_id}）：${body.text ?? ''}`);
      return reply(200, { ok: true, message_id: ev.message_id });
    }

    if (url.pathname === '/test/close' && req.method === 'POST') {
      // 主动断 WS，模拟协议端重启 / 网络断一下
      const alive = state.sock !== null;
      state.sock?.close();
      say('按 /test/close 主动断开');
      return reply(200, { ok: true, closed: alive });
    }

    if (url.pathname === '/test/state') {
      return reply(200, { connections: state.connections, sent: state.sent });
    }

    reply(404, { error: 'not found' });
  });

  return {
    state,
    onConnect: (fn) => state.connectHandlers.push(fn),
    listen: async () => {
      await new Promise((resolve, reject) => {
        wss.once('listening', resolve);
        wss.once('error', reject);
      });
      const wsAddress = wss.address();
      state.wsPort = typeof wsAddress === 'object' && wsAddress ? wsAddress.port : wsPort;
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        server.listen(httpPort, '127.0.0.1');
      });
      const httpAddress = server.address();
      state.httpPort = typeof httpAddress === 'object' && httpAddress ? httpAddress.port : httpPort;
      return { wsPort: state.wsPort, httpPort: state.httpPort };
    },
    close: () =>
      new Promise((resolve) => {
        try {
          state.sock?.terminate();
        } catch {
          /* 已经断了 */
        }
        wss.close();
        server.close(() => resolve(true));
      }),
  };
}

/** 起假协议端：默认 3002/3003，绑不上就退到 3102/3103，最后交给系统随便给 */
async function startMock({ silent = false } = {}) {
  const wsPick = await pickPort(WS_PORT, [3102, 4102, 0]);
  const httpPick = await pickPort(HTTP_PORT, [3103, 4103, 0]);
  if (wsPick.fellBack || httpPick.fellBack) {
    const wsNote = wsPick.fellBack ? `${WS_PORT} 绑不上` : '';
    const httpNote = httpPick.fellBack ? `${HTTP_PORT} 绑不上` : '';
    console.warn(
      `[mock] WARN ${[wsNote, httpNote].filter(Boolean).join('、')}（这台机器 2980–3079 是 Windows 排除端口范围）——本次改用 ws=${wsPick.port} http=${httpPick.port}`,
    );
  }
  const mock = createMock({ wsPort: wsPick.port, httpPort: httpPick.port, silent });
  const ports = await mock.listen();
  return { mock, ports };
}

// ---------- 常驻模式 ----------
async function runStandalone() {
  const { mock, ports } = await startMock();
  console.log(`[mock] 协议端 ws://127.0.0.1:${ports.wsPort}（冒充 NapCat，等 bot 来连）`);
  console.log(`[mock] 注入接口 http://127.0.0.1:${ports.httpPort}`);
  console.log('[mock] 起机器人：');
  console.log(
    `       ONEBOT_WS_URL=ws://127.0.0.1:${ports.wsPort} GUARD_GROUP_IDS=${GROUP_ID} OWNER_QQ=${SELF_ID} npm start`,
  );
  console.log('[mock] 注入一条群消息：');
  console.log(
    `       curl -X POST http://127.0.0.1:${ports.httpPort}/test/group -H "content-type: application/json" -d "{\\"text\\":\\"有人吗\\"}"`,
  );
  console.log('[mock] 断开 WS 测重连：');
  console.log(
    `       curl -X POST http://127.0.0.1:${ports.httpPort}/test/close -H "content-type: application/json" -d "{}"`,
  );
  void mock;
}

// ---------- smoke 模式 ----------
function runCmd(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out: out + `\n[超时 ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

async function runSmoke() {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  let botOut = '';
  const botLines = () =>
    stripAnsi(botOut)
      .split(/\r?\n/)
      .map((l) => l.trimEnd());
  const recvLines = () => botLines().filter((l) => l.startsWith('[recv]'));
  const countRecv = (needle) => recvLines().filter((l) => l.includes(needle)).length;

  async function waitFor(pred, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (pred()) return true;
      await sleep(50);
    }
    return pred();
  }

  let mock;
  let bot;
  let httpPort = HTTP_PORT;
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${httpPort}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return res.json();
  };

  try {
    // 验收 1：依赖装好了 + tsc 0 错误
    const hasWs = fs.existsSync(path.join(ROOT, 'node_modules', 'ws', 'package.json'));
    const hasTsc = fs.existsSync(path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'));
    const tsc = hasTsc
      ? await runCmd(process.execPath, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'])
      : { code: -1, out: '找不到 node_modules/typescript，先 npm install' };
    const tscClean = tsc.code === 0;
    record(
      '1. npm install 完成 + npm run check（tsc --noEmit）0 错误',
      hasWs && hasTsc && tscClean,
      tscClean ? 'tsc 无输出、退出码 0' : `tsc 退出码 ${tsc.code}：${tsc.out.split('\n').slice(0, 6).join(' | ')}`,
    );

    const started = await startMock({ silent: true });
    mock = started.mock;
    httpPort = started.ports.httpPort;
    console.log(
      `NOTE mock 端口 ws=${started.ports.wsPort} http=${started.ports.httpPort}（默认应为 3002/3003，见上方 WARN）`,
    );

    bot = spawn(process.execPath, ['src/index.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        ONEBOT_WS_URL: `ws://127.0.0.1:${started.ports.wsPort}`,
        GUARD_GROUP_IDS: String(GROUP_ID),
        OWNER_QQ: String(SELF_ID),
        LOG_LEVEL: 'info',
        MOCK_MODE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bot.stdout.on('data', (d) => (botOut += d.toString()));
    bot.stderr.on('data', (d) => (botOut += d.toString()));

    const connected = await waitFor(() => mock.state.connections >= 1, 15_000);
    if (!connected) {
      throw new Error(`bot 15s 内没连上 mock；bot 输出：\n${stripAnsi(botOut)}`);
    }
    await waitFor(() => botLines().some((l) => l.includes('已连上协议端')), 5000);

    // 验收 2：注入一条群消息，bot 打出来
    await post('/test/group', { text: '收到一条群消息', messageId: 61001 });
    const gotRecv = await waitFor(() => countRecv('群20001 30001 小王: 收到一条群消息') === 1, 5000);
    record(
      '2. 注入群消息 → bot 打印 [recv]',
      gotRecv,
      gotRecv ? recvLines().find((l) => l.includes('收到一条群消息')) : '5s 内没等到 [recv] 行',
    );

    // 验收 4：同一 message_id 注入两次，只打印一次
    await post('/test/group', { text: '重复的消息', messageId: 61002 });
    await post('/test/group', { text: '重复的消息', messageId: 61002 });
    await sleep(800);
    const dupCount = countRecv('重复的消息');
    record('4. 同一 message_id 注入两次 → 只打印一次', dupCount === 1, `[recv] 行数=${dupCount}（期望 1）`);

    // 验收 5：message_sent 回显 + 自己号发的消息，都不打印
    await post('/test/group', { text: '这是自己发的回显', messageId: 61003, postType: 'message_sent' });
    await post('/test/group', {
      text: '这是自己号发的群消息',
      messageId: 61004,
      userId: SELF_ID,
      nickname: SELF_NAME,
    });
    await sleep(800);
    const sentCount = countRecv('这是自己发的回显');
    const selfCount = countRecv('这是自己号发的群消息');
    record(
      '5. post_type=message_sent / sender.user_id=selfId → 不打印',
      sentCount === 0 && selfCount === 0,
      `message_sent 行数=${sentCount}，self 行数=${selfCount}（期望都是 0）`,
    );

    // 验收 6：非白名单群不打印
    await post('/test/group', { text: '别的群的消息', messageId: 61005, groupId: 99999 });
    await sleep(800);
    const otherCount = countRecv('别的群的消息');
    record('6. 非白名单群 → 不打印', otherCount === 0, `[recv] 行数=${otherCount}（期望 0）`);

    // 验收 3：主动断 WS，5 秒内重连（mock 收到新连接 + bot 日志可见）
    let reconnectedAt = 0;
    mock.onConnect(() => {
      if (reconnectedAt === 0) reconnectedAt = Date.now();
    });
    const closeAt = Date.now();
    await post('/test/close', {});
    const back = await waitFor(() => reconnectedAt > 0, 5000);
    const gapMs = reconnectedAt > 0 ? reconnectedAt - closeAt : -1;
    const reloginCount = botLines().filter((l) => l.includes('已连上协议端')).length;
    const gotRelog = await waitFor(
      () => botLines().filter((l) => l.includes('已连上协议端')).length >= 2,
      2000,
    );
    record(
      '3. /test/close 断开 → 5s 内自动重连',
      back && gapMs <= 5000 && gotRelog,
      back
        ? `重连用时 ${gapMs}ms，bot「已连上」日志 ${Math.max(reloginCount, 2)} 次`
        : '5s 内没重连上',
    );

    // 重连后还能继续收：证明重连不是"看着连上了但不干活"
    await post('/test/group', { text: '重连之后的新消息', messageId: 61006 });
    const afterRecv = await waitFor(() => countRecv('重连之后的新消息') === 1, 5000);
    record('3b. 重连后仍能收到新消息（附加）', afterRecv, afterRecv ? '收到' : '重连后 5s 内没收到');
  } catch (err) {
    record('运行异常', false, err.message);
  } finally {
    try {
      bot?.kill();
    } catch {
      /* 已退出 */
    }
    await sleep(200);
    try {
      await mock?.close();
    } catch {
      /* 已关 */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('==== 汇总 ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(failed.length === 0 ? '全部 PASS' : `${failed.length} 项 FAIL`);
  if (failed.length > 0) {
    console.log('---- bot 原始输出（尾部 40 行）----');
    console.log(
      stripAnsi(botOut)
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .slice(-40)
        .join('\n'),
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv.includes('--smoke')) {
  await runSmoke();
} else {
  await runStandalone();
}
