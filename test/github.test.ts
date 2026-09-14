import { describe, expect, it, vi } from "vitest";
import { fetchContributionCounts, loadGithubActivity } from "../src/github";
import type { ActivitySnapshot, ActivityStore } from "../src/types";
import calendarFixture from "./fixtures/github-calendar-september-9.html?raw";
import { githubCalendarResponse } from "./helpers/github";

interface MemoryStore extends ActivityStore {
  values: Map<string, ActivitySnapshot>;
}

function memoryStore(): MemoryStore {
  const values = new Map<string, ActivitySnapshot>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: ActivitySnapshot) => {
      values.set(key, value);
    }),
  };
}

function calendarFetcher(
  countsByYear: Record<number, Record<string, number>> = {},
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = new URL(String(input));
    const year = Number(url.searchParams.get("from")?.slice(0, 4));
    return Promise.resolve(
      githubCalendarResponse(year, countsByYear[year] ?? {}),
    );
  });
}

function allYearCounts(year: number, count: number): Record<string, number> {
  const counts: Record<string, number> = {};
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  while (date.getUTCFullYear() === year) {
    counts[date.toISOString().slice(0, 10)] = count;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return counts;
}

describe("GitHub activity", () => {
  it("parses the public calendar regression for September 9", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(calendarFixture));

    const counts = await fetchContributionCounts({
      username: "flamboh",
      from: new Date("2026-09-09T00:00:00Z"),
      to: new Date("2026-09-09T00:00:00Z"),
      fetcher,
    });

    expect(counts).toEqual({ "2026-09-09": 1 });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://github.com/users/flamboh/contributions?from=2026-01-01&to=2026-12-31",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });

  it("reads zero, singular, plural, and comma grouped tooltip counts", async () => {
    const html = [
      "<tool-tip>unrelated page hint</tool-tip>",
      '<tool-tip for="unrelated-id">unrelated page hint</tool-tip>',
      "<tool-tip for='day-3'> 2&nbsp; contributions on February&nbsp;29th. </tool-tip>",
      "<td class='ContributionCalendar-day' id='day-3' data-date='2024-02-29' data-level='0'></td>",
      '<td id="day-1" data-date="2024-02-28" class="ContributionCalendar-day" data-level="4"></td>',
      '<tool-tip for="day-1">1 contribution on February 28th.</tool-tip>',
      '<td data-date="2024-03-01" id="day-2" class="ContributionCalendar-day" data-level="0"></td>',
      '<tool-tip for="day-2">No contributions on March 1st.</tool-tip>',
      '<td data-date="2024-03-02" id="day-4" class="ContributionCalendar-day" data-level="1"></td>',
      '<tool-tip for="day-4">1,234 contributions on March 2nd.</tool-tip>',
    ].join("\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(html));

    const counts = await fetchContributionCounts({
      username: "octocat",
      from: new Date("2024-02-28T00:00:00Z"),
      to: new Date("2024-03-02T00:00:00Z"),
      fetcher,
    });

    expect(counts).toEqual({
      "2024-02-28": 1,
      "2024-02-29": 2,
      "2024-03-01": 0,
      "2024-03-02": 1234,
    });
  });

  it("fetches each touched year and filters to the requested dates", async () => {
    const fetcher = calendarFetcher({
      2023: { "2023-12-31": 3 },
      2024: { "2024-01-01": 4, "2024-01-02": 5 },
    });

    const counts = await fetchContributionCounts({
      username: "octocat",
      from: new Date("2023-12-31T00:00:00Z"),
      to: new Date("2024-01-02T00:00:00Z"),
      fetcher,
    });

    expect(counts).toEqual({
      "2023-12-31": 3,
      "2024-01-01": 4,
      "2024-01-02": 5,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "from=2023-01-01&to=2023-12-31",
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "from=2024-01-01&to=2024-12-31",
    );
  });

  it.each([
    [404, 404],
    [403, 429],
    [429, 429],
    [500, 502],
  ] as const)(
    "maps GitHub status %s to the public error status %s",
    async (upstreamStatus, expectedStatus) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: upstreamStatus }));

      await expect(
        fetchContributionCounts({
          username: "octocat",
          from: new Date("2026-01-01T00:00:00Z"),
          to: new Date("2026-01-01T00:00:00Z"),
          fetcher,
        }),
      ).rejects.toMatchObject({ status: expectedStatus });
    },
  );

  it.each([
    {
      name: "missing tooltip",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td>',
    },
    {
      name: "missing cell",
      html: '<tool-tip for="day">1 contribution on September 9th.</tool-tip>',
    },
    {
      name: "invalid tooltip",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td><tool-tip for="day">many contributions on September 9th.</tool-tip>',
    },
    {
      name: "negative count",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td><tool-tip for="day">-1 contributions on September 9th.</tool-tip>',
    },
    {
      name: "fractional count",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td><tool-tip for="day">1.5 contributions on September 9th.</tool-tip>',
    },
    {
      name: "unsafe count",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td><tool-tip for="day">9007199254740992 contributions on September 9th.</tool-tip>',
    },
    {
      name: "bad comma grouping",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td><tool-tip for="day">1,23 contributions on September 9th.</tool-tip>',
    },
    {
      name: "truncated tooltip",
      html: '<td data-date="2026-09-09" id="day" class="ContributionCalendar-day"></td><tool-tip for="day">1 contribution on September 9th.',
    },
  ])("rejects $name calendar markup", async ({ html }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(html));

    await expect(
      fetchContributionCounts({
        username: "octocat",
        from: new Date("2026-09-09T00:00:00Z"),
        to: new Date("2026-09-09T00:00:00Z"),
        fetcher,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("uses the v3 cache while retaining the original fetched timestamp", async () => {
    const store = memoryStore();
    const fetcher = calendarFetcher();
    const first = await loadGithubActivity({
      username: "octocat",
      store,
      fetcher,
      now: new Date("2026-07-15T12:00:00Z"),
    });
    const second = await loadGithubActivity({
      username: "octocat",
      store,
      fetcher,
      now: new Date("2026-07-15T13:00:00Z"),
    });

    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.values.has("github:activity:v3:octocat")).toBe(true);
  });

  it("refreshes cached GitHub counts when the Los Angeles date rolls over", async () => {
    const store = memoryStore();
    const fetcher = calendarFetcher();
    await loadGithubActivity({
      username: "octocat",
      store,
      fetcher,
      now: new Date("2026-07-15T06:30:00Z"),
    });
    await loadGithubActivity({
      username: "octocat",
      store,
      fetcher,
      now: new Date("2026-07-15T07:30:00Z"),
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not advance source timestamps when adding a missing fresh streak", async () => {
    const store = memoryStore();
    const fetcher = calendarFetcher();
    const first = await loadGithubActivity({
      username: "octocat",
      store,
      fetcher,
      now: new Date("2026-07-15T12:00:00Z"),
    });
    const second = await loadGithubActivity({
      username: "octocat",
      store,
      fetcher,
      now: new Date("2026-07-15T13:00:00Z"),
      includeStreak: true,
    });

    expect(second.fetchedThrough).toBe(first.fetchedThrough);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.streak).toEqual({ start: null, through: "2026-07-14" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the same today-or-yesterday streak semantics", async () => {
    const fetcher = calendarFetcher({
      2026: {
        "2026-07-13": 1,
        "2026-07-14": 2,
        "2026-07-15": 0,
      },
    });
    const snapshot = await loadGithubActivity({
      username: "octocat",
      store: memoryStore(),
      fetcher,
      now: new Date("2026-07-15T12:00:00Z"),
      includeStreak: true,
    });

    expect(snapshot.streak).toEqual({
      start: "2026-07-13",
      through: "2026-07-14",
    });
  });

  it("uses the Los Angeles date to determine today", async () => {
    const fetcher = calendarFetcher({
      2026: {
        "2026-07-13": 1,
        "2026-07-14": 0,
        "2026-07-15": 1,
      },
    });
    const snapshot = await loadGithubActivity({
      username: "octocat",
      store: memoryStore(),
      fetcher,
      now: new Date("2026-07-15T02:00:00Z"),
      includeStreak: true,
    });

    expect(snapshot.streak).toEqual({
      start: "2026-07-13",
      through: "2026-07-13",
    });
  });

  it("backfills streak history without fetching the same year twice", async () => {
    const fetcher = calendarFetcher({
      2025: allYearCounts(2025, 1),
      2026: allYearCounts(2026, 1),
    });
    const snapshot = await loadGithubActivity({
      username: "octocat",
      store: memoryStore(),
      fetcher,
      now: new Date("2026-07-15T12:00:00Z"),
      includeStreak: true,
    });

    expect(snapshot.streak).toEqual({
      start: "2025-01-01",
      through: "2026-07-15",
    });
    expect(
      fetcher.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.get("from"),
      ),
    ).toEqual(["2025-01-01", "2026-01-01", "2024-01-01"]);
  });

  it("stops streak backfills at the safe limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const year = Number(
        new URL(String(input)).searchParams.get("from")?.slice(0, 4),
      );
      return Promise.resolve(
        githubCalendarResponse(year, allYearCounts(year, 1)),
      );
    });

    await expect(
      loadGithubActivity({
        username: "octocat",
        store: memoryStore(),
        fetcher,
        now: new Date("2026-07-15T12:00:00Z"),
        includeStreak: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(11);
  });
});
