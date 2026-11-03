/**
 * 假 LLM 服务（假 Ollama + 假 DeepSeek），只用 node:http，供 scripts/test-models.mjs 断言。
 * 不发任何真实网络请求；端口用 0 让系统分配，实际端口打印成 PORT=<n>（单独运行时），
 * 测试里直接 import startFakeLlm() 拿 { url, port, stats, close }。
 *
 * 用例靠「baseUrl 的路径段」选：/clean/api/chat、/fence/chat/completions …
 *   screen.ts 会在 baseUrl 后拼 /api/chat、/api/tags；judge.ts 会拼 /chat/completions。
 *   所以 baseUrl=http://127.0.0.1:<port>/fence 就命中 fence 用例。
 * 不带用例段时：screen 默认 clean，judge 默认 normal。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const SCREEN_CASES = {
  clean: { verdict: 'clean', rule: 'OTHER', score: 0.05 },
  suspicious: { verdict: 'suspicious', rule: 'R4', score: 0.88 },
  fence: { verdict: 'suspicious', rule: 'REDLINE', score: 0.92 },
  badrule: { verdict: 'clean', rule: 'R99', score: 0.1 },
};

const JUDGE_NORMAL = {
  severity: 2,
  confidence: 0.82,
  reason: '群内发布加群广告，属第 4 条',
  rule: 'R4',
  extraRules: ['R6'],
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function screenBody(content) {
  // 形状照 Ollama /api/chat：message.content 里放模型正文
  return {
    model: 'fake-screen',
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
  };
}

function judgeBody(content, finishReason = 'stop', echo) {
  const out = {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: 'fake-judge',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
  if (echo !== undefined) out.echo = echo;
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw.length === 0 ? null : JSON.parse(raw));
      } catch {
        resolve({ __unparsed: raw.slice(0, 500) });
      }
    });
    req.on('error', () => resolve(null));
  });
}

function caseFromPath(pathname, tail) {
  const head = pathname.slice(0, pathname.length - tail.length);
  const seg = head.split('/').filter((s) => s.length > 0);
  return seg.length > 0 ? seg[seg.length - 1] : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeLlm({ port = 0 } = {}) {
  const stats = {
    count: 0,
    lastPath: '',
    lastBody: null,
    reset() {
      this.count = 0;
      this.lastPath = '';
      this.lastBody = null;
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/__stats') {
      json(res, 200, { count: stats.count, lastPath: stats.lastPath });
      return;
    }

    stats.count += 1;
    stats.lastPath = pathname;
    const body = await readBody(req);
    stats.lastBody = body;

    const queryDelay = Number(url.searchParams.get('delay') ?? '');
    const delayMs = Number.isFinite(queryDelay) && queryDelay > 0 ? queryDelay : 400;

    try {
      if (pathname.endsWith('/api/tags')) {
        json(res, 200, { models: [{ name: 'fake-screen:latest', size: 1 }] });
        return;
      }

      if (pathname.endsWith('/api/chat')) {
        const name = caseFromPath(pathname, '/api/chat');
        switch (name) {
          case 'suspicious':
          case 'fence':
          case 'badrule':
            json(res, 200, screenBody(JSON.stringify(SCREEN_CASES[name])));
            return;
          case 'nonjson':
            json(res, 200, screenBody('这条消息我觉得挺可疑的，但我不想按你要的格式回答。'));
            return;
          case 'slow':
            await sleep(delayMs);
            json(res, 200, screenBody(JSON.stringify(SCREEN_CASES.clean)));
            return;
          case '500':
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('ollama is on fire');
            return;
          case 'clean':
          default:
            json(res, 200, screenBody(JSON.stringify(SCREEN_CASES.clean)));
            return;
        }
      }

      if (pathname.endsWith('/chat/completions')) {
        const name = caseFromPath(pathname, '/chat/completions');
        switch (name) {
          case 'fence':
            json(res, 200, judgeBody('\u0060\u0060\u0060json\n' + JSON.stringify({ ...JUDGE_NORMAL, rule: 'R5', severity: 1 }) + '\n\u0060\u0060\u0060'));
            return;
          case 'prose':
            json(
              res,
              200,
              judgeBody(
                '好的，我分析完这条消息了，结论如下：\n' +
                  JSON.stringify({ severity: 3, confidence: 0.91, reason: '红线：涉及毒品交易', rule: 'REDLINE', extraRules: ['R4', 'REDLINE', 'R99'] }) +
                  '\n\n以上是我的判断，希望这个结论对管理员有帮助。',
              ),
            );
            return;
          case 'length':
            json(res, 200, judgeBody('', 'length'));
            return;
          case 'outofrange':
            json(
              res,
              200,
              judgeBody(JSON.stringify({ severity: 9, confidence: 1.7, reason: '越界字段测试', rule: 'R99', extraRules: ['R4', 'R99', 'R4'] })),
            );
            return;
          case 'slow':
            await sleep(delayMs);
            json(res, 200, judgeBody(JSON.stringify(JUDGE_NORMAL)));
            return;
          case '500':
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('deepseek is on fire');
            return;
          case 'echo':
            json(res, 200, judgeBody(JSON.stringify({ severity: 1, confidence: 0.6, reason: '带图回显测试', rule: 'OTHER', extraRules: [] }), 'stop', body));
            return;
          case 'nonjson':
            json(res, 200, judgeBody('我觉得还行。'));
            return;
          case 'normal':
          default:
            json(res, 200, judgeBody(JSON.stringify(JUDGE_NORMAL)));
            return;
        }
      }

      json(res, 404, { error: 'unknown path', path: pathname });
    } catch {
      // 客户端已超时断开：忽略写失败
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  return {
    port: actualPort,
    url: 'http://127.0.0.1:' + actualPort,
    stats,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const envPort = Number(process.env.FAKE_LLM_PORT ?? '0');
  const fake = await startFakeLlm({ port: Number.isFinite(envPort) ? envPort : 0 });
  console.log('PORT=' + fake.port);
  console.log('URL=' + fake.url);
  const shutdown = async () => {
    await fake.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
