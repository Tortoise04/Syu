const COLORS: Record<string, string> = {
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

const useColor = process.env.NO_COLOR === undefined;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = RANK.info;

export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

function on(level: LogLevel): boolean {
  return RANK[level] >= threshold;
}

function paint(color: string, text: string): string {
  return useColor ? `${COLORS[color] ?? ''}${text}${COLORS.reset}` : text;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export const log = {
  debug: (msg: string, ...rest: unknown[]) => {
    if (on('debug')) console.log(paint('dim', stamp()), paint('blue', '·'), msg, ...rest);
  },
  info: (msg: string, ...rest: unknown[]) => {
    if (on('info')) console.log(paint('dim', stamp()), paint('cyan', '·'), msg, ...rest);
  },
  ok: (msg: string) => {
    if (on('info')) console.log(paint('dim', stamp()), paint('green', '✓'), msg);
  },
  warn: (msg: string) => {
    if (on('warn')) console.log(paint('dim', stamp()), paint('yellow', '!'), msg);
  },
  error: (msg: string, err?: unknown) => {
    if (on('error')) console.error(paint('dim', stamp()), paint('red', '✗'), msg, err ?? '');
  },
  // 群消息这一行是 smoke 的断言对象，格式固定、不加时间戳前缀
  recv: (groupId: number, userId: number, nickname: string, text: string) => {
    if (on('info')) console.log(`[recv] 群${groupId} ${userId} ${nickname}: ${text}`);
  },
};
