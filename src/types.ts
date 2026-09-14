export interface Env {
  ACTIVITY_CACHE: KVNamespace;
  LASTFM_API_KEY: string;
}

export type ActivitySource = "lastfm" | "github";

export interface ActivitySnapshot {
  username: string;
  counts: Record<string, number>;
  fetchedThrough: number;
  updatedAt: number;
  streak?: ActivityStreak;
}

export interface ActivityStreak {
  start: string | null;
  through: string;
}

export interface ActivityStore {
  get(key: string): Promise<ActivitySnapshot | null>;
  put(key: string, value: ActivitySnapshot): Promise<void>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
