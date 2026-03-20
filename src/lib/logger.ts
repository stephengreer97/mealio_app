import { getAccessToken } from './tokenStorage';

const BASE_URL = 'https://mealio.co';

function sendLog(level: 'info' | 'warn' | 'error', event: string, detail?: string, error?: unknown): void {
  const errorMsg = error instanceof Error
    ? error.message
    : error != null
    ? String(error)
    : undefined;

  if (__DEV__) {
    if (level === 'error') {
      console.error(`[logger] ${event}`, detail ?? '', error ?? '');
    } else if (level === 'warn') {
      console.warn(`[logger] ${event}`, detail ?? '');
    } else {
      console.log(`[logger] ${event}`, detail ?? '');
    }
  }

  // Fire-and-forget: send to server in production (and dev, for testing server-side receipt)
  getAccessToken()
    .then((token) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      return fetch(`${BASE_URL}/api/client-log`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ level, event, detail, error: errorMsg }),
      });
    })
    .catch(() => {
      // Intentionally swallowed — logger must never throw or crash the app
    });
}

export const logger = {
  info(event: string, detail?: string): void {
    sendLog('info', event, detail);
  },
  warn(event: string, detail?: string): void {
    sendLog('warn', event, detail);
  },
  error(event: string, detail?: string, error?: unknown): void {
    sendLog('error', event, detail, error);
  },
};
