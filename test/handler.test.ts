import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/index";
import type { Env, ExecutionContextLike } from "../src/types";
import { githubCalendarResponse } from "./helpers/github";

function testContext(): ExecutionContextLike {
  return { waitUntil: vi.fn() };
}

function testEnv(): Env {
  const values = new Map<string, string>();
  return {
    LASTFM_API_KEY: "secret",
    ACTIVITY_CACHE: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = values.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace,
  };
}

function edgeCache(): Pick<Cache, "match" | "put"> {
  const values = new Map<string, Response>();
  return {
    match: vi.fn(async (request: RequestInfo | URL) => {
      const key = request instanceof Request ? request.url : String(request);
      return values.get(key)?.clone();
    }),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      const key = request instanceof Request ? request.url : String(request);
      values.set(key, response.clone());
    }),
  };
}

function githubFetcher(counts: Record<string, number> = {}) {
  return vi.fn<typeof fetch>().mockImplementation((input) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : String(input),
    );
    const year = Number(requestUrl.searchParams.get("to")?.slice(0, 4));
    return Promise.resolve(githubCalendarResponse(year, counts));
  });
}

describe("public handler", () => {
  it("shows both source URLs and live examples", async () => {
    const handle = createHandler({ edgeCache: edgeCache() });
    const response = await handle(
      new Request("https://graph.example/"),
      testEnv(),
      testContext(),
    );

    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("embeddable, matching activity graphs");
    expect(body).toContain(
      "https://heat.oli.boo/lastfm/<wbr><span>YOUR_USERNAME</span>",
    );
    expect(body).toContain(
      "https://heat.oli.boo/github/<wbr><span>YOUR_USERNAME</span>",
    );
    expect(body).toContain('src="https://heat.oli.boo/lastfm/flamboh"');
    expect(body).toContain('src="https://heat.oli.boo/github/flamboh"');
    expect(body).toContain(
      'data-copy="https://heat.oli.boo/lastfm/YOUR_USERNAME"',
    );
    expect(body).toContain(
      'data-copy="https://heat.oli.boo/github/YOUR_USERNAME"',
    );
    expect(body).toContain(
      '<footer>see <a href="https://github.com/flamboh/heatmaps">github</a> for more</footer>',
    );
    expect(body).not.toContain(".png");
    expect(body).not.toContain("/streak");
    expect(body).not.toContain("<pre");
  });

  it("rejects invalid usernames without calling Last.fm", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handle = createHandler({ fetcher, edgeCache: edgeCache() });
    const response = await handle(
      new Request("https://graph.example/lastfm/a%2Fb"),
      testEnv(),
      testContext(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns and schedules caching of a generated Last.fm SVG", async () => {
    const context = testContext();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: { "@attr": { totalPages: "1" }, track: [] },
      }),
    );
    const handle = createHandler({
      fetcher,
      edgeCache: edgeCache(),
      now: () => new Date("2026-07-15T12:00:00Z"),
    });
    const response = await handle(
      new Request("https://graph.example/lastfm/listener"),
      testEnv(),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=21600");
    expect(await response.text()).toContain("listener's Last.fm activity");
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });

  it("supports an explicit Last.fm SVG extension", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: { "@attr": { totalPages: "1" }, track: [] },
      }),
    );
    const handle = createHandler({ fetcher, edgeCache: edgeCache() });
    const response = await handle(
      new Request("https://graph.example/lastfm/listener.svg"),
      testEnv(),
      testContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(await response.text()).toContain("listener's Last.fm activity");
  });

  it("supports canonical Last.fm routes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: { "@attr": { totalPages: "1" }, track: [] },
      }),
    );
    const response = await createHandler({
      fetcher,
      edgeCache: edgeCache(),
    })(
      new Request("https://graph.example/lastfm/listener.svg"),
      testEnv(),
      testContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("listener's Last.fm activity");
  });

  it.each([
    "/listener",
    "/listener.svg",
    "/listener.png?theme=dark",
    "/listener/streak",
    "/listener/total",
  ])("does not maintain the legacy Last.fm route %s", async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createHandler({
      fetcher,
      edgeCache: edgeCache(),
    })(new Request(`https://graph.example${path}`), testEnv(), testContext());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the public calendar across GitHub output formats without a token", async () => {
    const fetcher = githubFetcher({ "2026-09-09": 1 });
    const cache = edgeCache();
    const env = testEnv();
    const rasterize = vi.fn(
      async (_svg: string) => new Uint8Array([137, 80, 78, 71]),
    );
    const handle = createHandler({
      fetcher,
      rasterize,
      edgeCache: cache,
      now: () => new Date("2026-09-09T19:00:00Z"),
    });

    const svg = await handle(
      new Request("https://graph.example/github/octocat.svg"),
      env,
      testContext(),
    );
    expect(svg.status).toBe(200);
    const body = await svg.text();
    expect(body).toContain("octocat's GitHub activity");
    expect(body).toContain('data-date="2026-09-09" data-count="1"');

    const total = await handle(
      new Request("https://graph.example/github/octocat/total"),
      env,
      testContext(),
    );
    expect(await total.json()).toEqual({
      total: 1,
      from: "2025-09-07",
      to: "2026-09-09",
    });

    const streak = await handle(
      new Request("https://graph.example/github/octocat/streak"),
      env,
      testContext(),
    );
    expect(await streak.json()).toEqual({ streak: 1 });

    const png = await handle(
      new Request(
        "https://graph.example/github/octocat.png?theme=dark&display=minimal",
      ),
      env,
      testContext(),
    );
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(rasterize.mock.calls[0]?.[0]).toContain(
      ".level-4 { fill: #39d353; }",
    );
    expect(rasterize.mock.calls[0]?.[0]).toContain(
      'data-date="2026-09-09" data-count="1"',
    );
    expect(rasterize.mock.calls[0]?.[0]).toContain('width="686" height="88"');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns GitHub contributions for the exact displayed local range", async () => {
    const context = testContext();
    const cache = edgeCache();
    const fetcher = githubFetcher({
      "2025-07-12": 100,
      "2025-07-13": 2,
      "2026-07-15": 3,
      "2026-07-16": 200,
    });
    const env = testEnv();
    const handle = createHandler({
      fetcher,
      edgeCache: cache,
      now: () => new Date("2026-07-15T23:59:59Z"),
    });
    const request = new Request("https://graph.example/github/octocat/total");
    const response = await handle(request, env, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=21600");
    expect(await response.json()).toEqual({
      total: 5,
      from: "2025-07-13",
      to: "2026-07-15",
    });
    expect(context.waitUntil).toHaveBeenCalledOnce();

    const cachedContext = testContext();
    const cachedResponse = await handle(request, env, cachedContext);
    expect(await cachedResponse.json()).toEqual({
      total: 5,
      from: "2025-07-13",
      to: "2026-07-15",
    });
    expect(cachedContext.waitUntil).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rolls GitHub edge cache keys at the local midnight", async () => {
    let now = new Date("2026-09-09T06:59:59Z");
    const context = testContext();
    const cache = edgeCache();
    const env = testEnv();
    const fetcher = githubFetcher({
      "2026-09-08": 1,
      "2026-09-09": 2,
    });
    const handle = createHandler({
      fetcher,
      edgeCache: cache,
      now: () => now,
    });
    const request = new Request("https://graph.example/github/octocat/total");

    const beforeMidnight = await handle(request, env, context);
    expect(await beforeMidnight.json()).toEqual({
      total: 1,
      from: "2025-09-07",
      to: "2026-09-08",
    });

    const sameDay = await handle(request, env, testContext());
    expect(await sameDay.json()).toEqual({
      total: 1,
      from: "2025-09-07",
      to: "2026-09-08",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    now = new Date("2026-09-09T07:00:00Z");
    const afterMidnight = await handle(request, env, testContext());
    expect(await afterMidnight.json()).toEqual({
      total: 3,
      from: "2025-09-07",
      to: "2026-09-09",
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("returns the current local listening streak as JSON", async () => {
    const context = testContext();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: {
          "@attr": { totalPages: "1" },
          track: [
            {
              date: { uts: String(Date.parse("2026-07-14T12:00:00Z") / 1000) },
            },
            {
              date: { uts: String(Date.parse("2026-07-13T12:00:00Z") / 1000) },
            },
          ],
        },
      }),
    );
    const handle = createHandler({
      fetcher,
      edgeCache: edgeCache(),
      now: () => new Date("2026-07-15T12:00:00Z"),
    });
    const response = await handle(
      new Request("https://graph.example/lastfm/listener/streak"),
      testEnv(),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=21600");
    expect(await response.json()).toEqual({ streak: 2 });
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });

  it("returns Last.fm scrobbles for the exact displayed local range", async () => {
    const context = testContext();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: {
          "@attr": { totalPages: "1" },
          track: [
            {
              date: { uts: String(Date.parse("2025-07-12T12:00:00Z") / 1000) },
            },
            {
              date: { uts: String(Date.parse("2025-07-13T12:00:00Z") / 1000) },
            },
            {
              date: { uts: String(Date.parse("2026-07-15T12:00:00Z") / 1000) },
            },
            {
              date: { uts: String(Date.parse("2026-07-16T12:00:00Z") / 1000) },
            },
          ],
        },
      }),
    );
    const response = await createHandler({
      fetcher,
      edgeCache: edgeCache(),
      now: () => new Date("2026-07-15T23:59:59Z"),
    })(
      new Request("https://graph.example/lastfm/listener/total"),
      testEnv(),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=21600");
    expect(await response.json()).toEqual({
      total: 2,
      from: "2025-07-13",
      to: "2026-07-15",
    });
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });

  it.each(["streak", "total"])(
    "returns JSON errors for %s requests",
    async (endpoint) => {
      const fetcher = vi.fn<typeof fetch>();
      const handle = createHandler({ fetcher, edgeCache: edgeCache() });
      const response = await handle(
        new Request(`https://graph.example/lastfm/a%2Fb/${endpoint}`),
        testEnv(),
        testContext(),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        error: "Invalid Last.fm username",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit PNG theme", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handle = createHandler({ fetcher, edgeCache: edgeCache() });
    const response = await handle(
      new Request("https://graph.example/lastfm/listener.png"),
      testEnv(),
      testContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "PNG requests require ?theme=light or ?theme=dark",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unknown display modes", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handle = createHandler({ fetcher, edgeCache: edgeCache() });
    const response = await handle(
      new Request("https://graph.example/lastfm/listener.svg?display=compact"),
      testEnv(),
      testContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "display must be full, dates, or minimal",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a fixed-theme PNG", async () => {
    const context = testContext();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        recenttracks: { "@attr": { totalPages: "1" }, track: [] },
      }),
    );
    const rasterize = vi.fn(
      async (_svg: string) => new Uint8Array([137, 80, 78, 71]),
    );
    const handle = createHandler({
      fetcher,
      rasterize,
      edgeCache: edgeCache(),
      now: () => new Date("2026-07-15T12:00:00Z"),
    });
    const response = await handle(
      new Request(
        "https://graph.example/lastfm/listener.png?theme=dark&display=minimal",
      ),
      testEnv(),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    expect(rasterize).toHaveBeenCalledOnce();
    expect(rasterize.mock.calls[0]?.[0]).toContain(
      ".level-0 { fill: #111111; }",
    );
    expect(rasterize.mock.calls[0]?.[0]).not.toContain(
      "@media (prefers-color-scheme: dark)",
    );
    expect(rasterize.mock.calls[0]?.[0]).toContain('width="686" height="88"');
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });
});
