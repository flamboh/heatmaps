import { Parser } from "htmlparser2";
import { addUtcDays, getCalendarRange, toDateKey, unixNow } from "./dates";
import type { ActivitySnapshot, ActivityStore, ActivityStreak } from "./types";

const CALENDAR_URL = "https://github.com/users";
const FRESH_FOR_SECONDS = 6 * 60 * 60;
const MAX_RANGE_DAYS = 365;
const MAX_STREAK_BACKFILLS = 10;

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

interface GithubOptions {
  username: string;
  fetcher: typeof fetch;
}

type YearCache = Map<number, Promise<Record<string, number>>>;

export interface LoadGithubActivityOptions {
  username: string;
  store: ActivityStore;
  fetcher?: typeof fetch;
  now?: Date;
  includeStreak?: boolean;
}

export async function loadGithubActivity({
  username,
  store,
  fetcher = fetch,
  now = new Date(),
  includeStreak = false,
}: LoadGithubActivityOptions): Promise<ActivitySnapshot> {
  const cacheKey = `github:activity:v3:${username.toLowerCase()}`;
  const cached = await store.get(cacheKey);
  const currentUnix = unixNow(now);
  const sameCalendarDate =
    cached !== null &&
    toDateKey(currentUnix) === toDateKey(cached.fetchedThrough);
  const fresh = Boolean(
    cached &&
    currentUnix - cached.updatedAt < FRESH_FOR_SECONDS &&
    sameCalendarDate,
  );

  if (fresh && cached && (!includeStreak || cached.streak)) return cached;

  const range = getCalendarRange(now);
  const yearCache: YearCache = new Map();
  if (fresh && cached) {
    const streak = await resolveStreak({
      counts: cached.counts,
      rangeStart: dateKey(range.start),
      previous: cached.streak,
      username,
      fetcher,
      now,
      yearCache,
    });
    const snapshot: ActivitySnapshot = { ...cached, streak };
    await store.put(cacheKey, snapshot);
    return snapshot;
  }

  const counts = await fetchContributionCounts({
    username,
    fetcher,
    from: range.start,
    to: range.end,
    yearCache,
  });
  const snapshot: ActivitySnapshot = {
    username,
    counts,
    fetchedThrough: currentUnix,
    updatedAt: currentUnix,
  };
  if (includeStreak || cached?.streak) {
    snapshot.streak = await resolveStreak({
      counts,
      rangeStart: dateKey(range.start),
      previous: cached?.streak,
      username,
      fetcher,
      now,
      yearCache,
    });
  }
  await store.put(cacheKey, snapshot);
  return snapshot;
}

interface FetchContributionCountsOptions extends GithubOptions {
  from: Date;
  to: Date;
  yearCache?: YearCache;
}

export async function fetchContributionCounts({
  username,
  fetcher,
  from,
  to,
  yearCache = new Map(),
}: FetchContributionCountsOptions): Promise<Record<string, number>> {
  const fromKey = dateKey(from);
  const toKey = dateKey(to);
  if (fromKey > toKey) return {};

  const firstYear = Number(fromKey.slice(0, 4));
  const lastYear = Number(toKey.slice(0, 4));
  const counts: Record<string, number> = {};

  // GitHub selects a single year even when the URL's date range spans years.
  for (let year = firstYear; year <= lastYear; year += 1) {
    const yearCounts = await fetchCalendarYear({
      username,
      fetcher,
      year,
      yearCache,
    });
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const requestedStart = fromKey > yearStart ? fromKey : yearStart;
    const requestedEnd = toKey < yearEnd ? toKey : yearEnd;

    for (
      let date = requestedStart;
      date <= requestedEnd;
      date = shiftDateKey(date, 1)
    ) {
      const count = yearCounts[date];
      if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
        throw new GithubError(
          "GitHub returned an incomplete contribution calendar",
        );
      }
      counts[date] = count;
    }
  }

  return counts;
}

async function fetchCalendarYear({
  username,
  fetcher,
  year,
  yearCache,
}: GithubOptions & { year: number; yearCache: YearCache }): Promise<
  Record<string, number>
> {
  const cached = yearCache.get(year);
  if (cached) return cached;

  const request = fetchCalendarPage({ username, fetcher, year });
  yearCache.set(year, request);
  return request;
}

async function fetchCalendarPage({
  username,
  fetcher,
  year,
}: GithubOptions & { year: number }): Promise<Record<string, number>> {
  const url = new URL(
    `${CALENDAR_URL}/${encodeURIComponent(username)}/contributions`,
  );
  url.searchParams.set("from", `${year}-01-01`);
  url.searchParams.set("to", `${year}-12-31`);

  const response = await fetcher(url, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US",
      "User-Agent": "heatmaps/0.1 (+https://github.com/flamboh/heatmaps)",
    },
  });
  if (!response.ok) {
    const status =
      response.status === 404
        ? 404
        : response.status === 403 || response.status === 429
          ? 429
          : 502;
    throw new GithubError(`GitHub request failed (${response.status})`, status);
  }

  let html: string;
  try {
    html = await response.text();
  } catch {
    throw new GithubError("GitHub returned an unexpected response");
  }
  return parseCalendar(html, year);
}

interface CalendarCell {
  date: string;
  id: string;
}

interface CalendarTooltip {
  id: string;
  text: string;
  complete: boolean;
}

function parseCalendar(html: string, year: number): Record<string, number> {
  const cellsByDate = new Map<string, CalendarCell>();
  const cellsById = new Map<string, CalendarCell>();
  const tooltips = new Map<string, CalendarTooltip[]>();
  let activeCell: CalendarCell | null = null;
  let activeTooltip: CalendarTooltip | null = null;

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (
          name === "td" &&
          hasClass(attributes.class, "ContributionCalendar-day")
        ) {
          if (activeCell) {
            throw new GithubError(
              "GitHub returned malformed contribution calendar markup",
            );
          }
          const date = attributes["data-date"];
          const id = attributes.id;
          if (!date || !id) {
            throw new GithubError(
              "GitHub returned an invalid contribution calendar cell",
            );
          }
          const cell = { date, id };
          if (cellsByDate.has(date) || cellsById.has(id)) {
            throw new GithubError(
              "GitHub returned duplicate contribution calendar cells",
            );
          }
          activeCell = cell;
          cellsByDate.set(date, cell);
          cellsById.set(id, cell);
        }
        if (name === "tool-tip") {
          if (activeTooltip) {
            throw new GithubError(
              "GitHub returned malformed contribution tooltip markup",
            );
          }
          const id = attributes.for;
          if (id) activeTooltip = { id, text: "", complete: true };
        }
      },
      ontext(text) {
        if (activeTooltip) activeTooltip.text += text;
      },
      onclosetag(name, isImplied) {
        if (name === "td" && activeCell) {
          if (isImplied)
            throw new GithubError(
              "GitHub returned truncated contribution markup",
            );
          activeCell = null;
        }
        if (name === "tool-tip" && activeTooltip) {
          const tooltip = activeTooltip;
          activeTooltip = null;
          const matching = tooltips.get(tooltip.id) ?? [];
          matching.push({
            id: tooltip.id,
            text: normalizeWhitespace(tooltip.text),
            complete: !isImplied,
          });
          tooltips.set(tooltip.id, matching);
        }
      },
      onerror() {
        throw new GithubError(
          "GitHub returned malformed contribution calendar markup",
        );
      },
    },
    { decodeEntities: true },
  );
  try {
    parser.end(html);
  } catch (error) {
    if (error instanceof GithubError) throw error;
    throw new GithubError(
      "GitHub returned malformed contribution calendar markup",
    );
  }

  if (activeCell || activeTooltip) {
    throw new GithubError(
      "GitHub returned malformed contribution calendar markup",
    );
  }

  const counts: Record<string, number> = {};
  for (const cell of cellsByDate.values()) {
    if (!isDateKeyForYear(cell.date, year)) {
      throw new GithubError("GitHub returned an invalid contribution date");
    }
    const matchingTooltips = tooltips.get(cell.id);
    if (
      !matchingTooltips ||
      matchingTooltips.length !== 1 ||
      !matchingTooltips[0]!.complete
    ) {
      throw new GithubError(
        "GitHub returned an incomplete contribution calendar",
      );
    }
    counts[cell.date] = parseTooltipCount(matchingTooltips[0]!.text);
  }
  return counts;
}

function hasClass(value: string | undefined, expected: string): boolean {
  return value?.split(/\s+/u).includes(expected) ?? false;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function parseTooltipCount(text: string): number {
  if (/^No contributions(?: on .+)?\.?$/u.test(text)) return 0;

  const match = /^(\d[\d,]*) (contribution|contributions)(?: on .+)?\.?$/u.exec(
    text,
  );
  if (!match) {
    throw new GithubError("GitHub returned an invalid contribution tooltip");
  }

  const rawCount = match[1]!;
  if (!/^\d+$/u.test(rawCount) && !/^\d{1,3}(?:,\d{3})+$/u.test(rawCount)) {
    throw new GithubError("GitHub returned an invalid contribution count");
  }
  const count = Number(rawCount.replaceAll(",", ""));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new GithubError("GitHub returned an invalid contribution count");
  }
  if (
    (match[2] === "contribution" && count !== 1) ||
    (match[2] === "contributions" && count === 1)
  ) {
    throw new GithubError("GitHub returned an invalid contribution count");
  }
  return count;
}

function isDateKeyForYear(value: string, year: number): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match || Number(match[1]) !== year) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

interface ResolveStreakOptions extends GithubOptions {
  counts: Record<string, number>;
  rangeStart: string;
  previous?: ActivityStreak;
  now: Date;
  yearCache: YearCache;
}

async function resolveStreak({
  counts,
  rangeStart,
  previous,
  username,
  fetcher,
  now,
  yearCache,
}: ResolveStreakOptions): Promise<ActivityStreak> {
  const today = toDateKey(unixNow(now));
  const through = counts[today] ? today : shiftDateKey(today, -1);
  const recent = findStreakStart(counts, through, rangeStart);
  if (recent !== undefined) return { start: recent, through };
  if (previous?.start && previous.start <= rangeStart) {
    return { start: previous.start, through };
  }

  let candidateStart = rangeStart;
  for (let attempt = 0; attempt < MAX_STREAK_BACKFILLS; attempt += 1) {
    const windowEnd = shiftDateKey(candidateStart, -1);
    const windowStart = shiftDateKey(windowEnd, -(MAX_RANGE_DAYS - 1));
    const older = await fetchContributionCounts({
      username,
      fetcher,
      from: dateFromKey(windowStart),
      to: new Date(addUtcDays(dateFromKey(windowEnd), 1).getTime() - 1),
      yearCache,
    });
    const start = findStreakStart(older, windowEnd, windowStart);
    if (start !== undefined) return { start, through };
    candidateStart = windowStart;
  }
  throw new GithubError("Streak history exceeds the safe backfill limit", 422);
}

function findStreakStart(
  counts: Record<string, number>,
  through: string,
  rangeStart: string,
): string | null | undefined {
  for (let date = through; date >= rangeStart; date = shiftDateKey(date, -1)) {
    if (!counts[date]) return date === through ? null : shiftDateKey(date, 1);
  }
  return undefined;
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateFromKey(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function shiftDateKey(value: string, days: number): string {
  return dateKey(addUtcDays(dateFromKey(value), days));
}
