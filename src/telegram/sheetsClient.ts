interface SheetUser {
  name: string;
  telegram_id: string;
  role: string;
  active: string;
}

interface CacheEntry {
  users: SheetUser[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

function sheetCsvUrl(): string {
  const sheetId = process.env.GOOGLE_SHEET_ID ?? '18KTiNj8VQgxl6mKqUoScOco15PZbYA6jgyNj0VxaTeM';
  const gid = process.env.GOOGLE_SHEET_GID ?? '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

function parseCsv(text: string): SheetUser[] {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  const idIdx = headers.indexOf('telegram_id');
  const roleIdx = headers.indexOf('role');
  const activeIdx = headers.indexOf('active');
  if (idIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      name: nameIdx !== -1 ? (cols[nameIdx] ?? '').trim() : '',
      telegram_id: (cols[idIdx] ?? '').trim(),
      role: roleIdx !== -1 ? (cols[roleIdx] ?? '').trim() : 'user',
      active: activeIdx !== -1 ? (cols[activeIdx] ?? '').trim() : 'true',
    };
  });
}

async function fetchUsers(): Promise<SheetUser[]> {
  const ttl = Number(process.env.SHEET_CACHE_TTL ?? 300) * 1000;
  const now = Date.now();
  if (cache && now - cache.fetchedAt < ttl) return cache.users;

  try {
    const response = await fetch(sheetCsvUrl());
    if (!response.ok) throw new Error(`Sheet fetch failed: ${response.status}`);
    const text = await response.text();
    const users = parseCsv(text);
    cache = { users, fetchedAt: now };
    return users;
  } catch (err) {
    console.error('[sheets] Failed to fetch users:', err);
    return cache?.users ?? [];
  }
}

export async function isAllowed(chatId: number | string): Promise<boolean> {
  const users = await fetchUsers();
  const id = String(chatId);
  return users.some(
    (u) => u.telegram_id === id && u.active.toLowerCase() === 'true'
  );
}

export async function getUser(chatId: number | string): Promise<SheetUser | undefined> {
  const users = await fetchUsers();
  const id = String(chatId);
  return users.find((u) => u.telegram_id === id);
}

export async function getActiveUsers(): Promise<SheetUser[]> {
  const users = await fetchUsers();
  return users.filter((u) => u.active.toLowerCase() === 'true');
}

export async function forceRefresh(): Promise<SheetUser[]> {
  cache = null;
  return fetchUsers();
}
