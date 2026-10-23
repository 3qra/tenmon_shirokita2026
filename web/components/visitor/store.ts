// 来場者端末に保存する「自分の注文・予約」の控え。
// 保存するのはアクセス用トークンと表示用の最小限の情報のみ（氏名などは保存しない）。
// プライベートブラウズ等で localStorage が使えない場合もあるため、すべて try/catch で囲む。

export type SavedOrder = {
  token: string;
  department_name: string;
  call_number: number;
  saved_at: string;
};

export type SavedReservation = {
  token: string;
  reservation_no: string;
  title: string;
  starts_at: string;
  saved_at: string;
};

const ORDERS_KEY = "gakusai.myOrders.v1";
const RESERVATIONS_KEY = "gakusai.myReservations.v1";
const MAX_ENTRIES = 30;

function readList<T extends { token: string }>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v.filter((x) => x && typeof x.token === "string") as T[]) : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, list: T[]): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(list.slice(0, MAX_ENTRIES)));
    return true;
  } catch {
    return false;
  }
}

function upsert<T extends { token: string }>(key: string, entry: T): boolean {
  const list = readList<T>(key).filter((x) => x.token !== entry.token);
  return writeList(key, [entry, ...list]);
}

function remove<T extends { token: string }>(key: string, token: string): boolean {
  return writeList(
    key,
    readList<T>(key).filter((x) => x.token !== token),
  );
}

export const myOrders = {
  list: () => readList<SavedOrder>(ORDERS_KEY),
  save: (e: SavedOrder) => upsert(ORDERS_KEY, e),
  remove: (token: string) => remove<SavedOrder>(ORDERS_KEY, token),
  has: (token: string) => readList<SavedOrder>(ORDERS_KEY).some((x) => x.token === token),
};

export const myReservations = {
  list: () => readList<SavedReservation>(RESERVATIONS_KEY),
  save: (e: SavedReservation) => upsert(RESERVATIONS_KEY, e),
  remove: (token: string) => remove<SavedReservation>(RESERVATIONS_KEY, token),
  has: (token: string) => readList<SavedReservation>(RESERVATIONS_KEY).some((x) => x.token === token),
};
