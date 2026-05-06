type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const activeLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';

const shouldLog = (level: LogLevel) => order[level] >= order[activeLevel];

const write = (level: LogLevel, message: string, meta?: unknown): void => {
  if (!shouldLog(level)) return;
  const payload = {
    level,
    message,
    time: new Date().toISOString(),
    ...(meta !== undefined ? { meta } : {})
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta)
};
