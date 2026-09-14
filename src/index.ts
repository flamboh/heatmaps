import { GithubError, loadGithubActivity } from "./github";
import { getCalendarTotal, toDateKey, unixNow } from "./dates";
import { loadActivity, LastfmError, streakDays } from "./lastfm";
import { renderActivitySvg, renderErrorSvg } from "./svg";
import type { GraphDisplay, GraphTheme } from "./svg";
import type {
  ActivitySnapshot,
  ActivitySource,
  ActivityStore,
  Env,
  ExecutionContextLike,
} from "./types";

const SVG_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};
const PNG_HEADERS = {
  "Content-Type": "image/png",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};
const CACHE_VERSION = 12;

type Output =
  | { format: "svg"; display: GraphDisplay }
  | {
      format: "png";
      theme: GraphTheme;
      display: GraphDisplay;
    }
  | { format: "streak" }
  | { format: "total" };

interface ParsedRequest {
  source: ActivitySource;
  username: string;
  output: Output;
}

export interface HandlerDependencies {
  fetcher?: typeof fetch;
  now?: () => Date;
  edgeCache?: Pick<Cache, "match" | "put">;
  rasterize?: (svg: string) => Promise<Uint8Array>;
}

export function createHandler(dependencies: HandlerDependencies = {}) {
  return async function handle(
    request: Request,
    env: Env,
    context: ExecutionContextLike,
  ): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(1)).trim();
    if (!path) return landingPage();
    const parsed = parseRequest(path, url.searchParams);
    if (parsed instanceof Response) return parsed;
    const { source, username, output } = parsed;
    if (!isValidUsername(source, username)) {
      return errorResponse(
        source,
        output,
        `Invalid ${source === "github" ? "GitHub" : "Last.fm"} username`,
        400,
        60,
      );
    }

    const now = dependencies.now?.() ?? new Date();
    const cache =
      dependencies.edgeCache ??
      (caches as CacheStorage & { default: Cache }).default;
    const dateSegment =
      source === "github" ? `/${toDateKey(unixNow(now))}` : "";
    const cacheKey = new Request(
      `${url.origin}/__heatmaps-cache/v${CACHE_VERSION}/${source}/${cachePath(output)}${dateSegment}/${encodeURIComponent(username.toLowerCase())}`,
    );
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return request.method === "HEAD"
        ? new Response(null, cachedResponse)
        : cachedResponse;
    }

    const missingSecret = source === "lastfm" && !env.LASTFM_API_KEY;
    if (missingSecret) {
      return errorResponse(
        source,
        output,
        "Server is missing LASTFM_API_KEY",
        500,
        0,
      );
    }

    try {
      const store = kvStore(env.ACTIVITY_CACHE);
      const snapshot =
        source === "github"
          ? await loadGithubActivity({
              username,
              store,
              fetcher: dependencies.fetcher,
              now,
              includeStreak: output.format === "streak",
            })
          : await loadActivity({
              username,
              apiKey: env.LASTFM_API_KEY,
              store,
              fetcher: dependencies.fetcher,
              now,
              includeStreak: output.format === "streak",
            });
      const response =
        output.format === "streak"
          ? jsonResponse(
              { streak: streakDays(snapshot.streak!) },
              200,
              6 * 60 * 60,
            )
          : output.format === "total"
            ? jsonResponse(
                getCalendarTotal(snapshot.counts, now),
                200,
                6 * 60 * 60,
              )
            : await imageResponse(
                renderActivitySvg(snapshot, {
                  source,
                  now,
                  theme: output.format === "png" ? output.theme : undefined,
                  display: output.display,
                }),
                output,
                200,
                6 * 60 * 60,
                dependencies.rasterize,
              );
      context.waitUntil(cache.put(cacheKey, response.clone()));
      return request.method === "HEAD"
        ? new Response(null, response)
        : response;
    } catch (error) {
      const status =
        error instanceof LastfmError || error instanceof GithubError
          ? error.status
          : 500;
      const message =
        error instanceof Error ? error.message : "Unexpected error";
      return errorResponse(
        source,
        output,
        message,
        status,
        status === 429 ? 60 : 300,
      );
    }
  };
}

function parseRequest(
  path: string,
  searchParams: URLSearchParams,
): ParsedRequest | Response {
  const segments = path.split("/");
  const sourceSegment = segments.shift();
  if (sourceSegment !== "lastfm" && sourceSegment !== "github") {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const source: ActivitySource = sourceSegment;
  let resource = segments.join("/");

  if (resource.endsWith("/streak")) {
    return {
      source,
      username: resource.slice(0, -"/streak".length),
      output: { format: "streak" },
    };
  }

  if (resource.endsWith("/total")) {
    return {
      source,
      username: resource.slice(0, -"/total".length),
      output: { format: "total" },
    };
  }

  const display = searchParams.get("display") ?? "full";
  if (display !== "full" && display !== "dates" && display !== "minimal") {
    return new Response("display must be full, dates, or minimal", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!resource.endsWith(".png")) {
    if (resource.endsWith(".svg")) resource = resource.slice(0, -4);
    return {
      source,
      username: resource,
      output: { format: "svg", display },
    };
  }

  const theme = searchParams.get("theme");
  if (theme !== "light" && theme !== "dark") {
    return new Response("PNG requests require ?theme=light or ?theme=dark", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return {
    source,
    username: resource.slice(0, -4),
    output: { format: "png", theme, display },
  };
}

const handle = createHandler();

export default {
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    return handle(request, env, context);
  },
};

function kvStore(namespace: KVNamespace): ActivityStore {
  return {
    get(key) {
      return namespace.get<ActivitySnapshot>(key, "json");
    },
    put(key, value) {
      return namespace.put(key, JSON.stringify(value), {
        expirationTtl: 400 * 24 * 60 * 60,
      });
    },
  };
}

function isValidUsername(source: ActivitySource, username: string): boolean {
  if (source === "github") {
    return (
      username.length <= 39 &&
      /^(?!-)(?!.*--)[A-Za-z0-9-]+(?<!-)$/.test(username)
    );
  }
  return username.length <= 64 && /^[\p{L}\p{N}_. -]+$/u.test(username);
}

function svgResponse(svg: string, status: number, maxAge: number): Response {
  return new Response(svg, {
    status,
    headers: {
      ...SVG_HEADERS,
      "Cache-Control": `public, max-age=300, s-maxage=${maxAge}`,
    },
  });
}

function jsonResponse(body: object, status: number, maxAge: number): Response {
  return Response.json(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      "Cache-Control": `public, max-age=300, s-maxage=${maxAge}`,
    },
  });
}

function errorResponse(
  source: ActivitySource,
  output: Output,
  message: string,
  status: number,
  maxAge: number,
): Response {
  return output.format === "streak" || output.format === "total"
    ? jsonResponse({ error: message }, status, maxAge)
    : svgResponse(renderErrorSvg(message, source), status, maxAge);
}

function cachePath(output: Output): string {
  if (output.format === "streak") return "streak";
  if (output.format === "total") return "total";
  return `${output.format}/${output.format === "png" ? output.theme : "adaptive"}/${output.display}`;
}

async function imageResponse(
  svg: string,
  output: Exclude<Output, { format: "streak" | "total" }>,
  status: number,
  maxAge: number,
  rasterize = defaultRasterize,
): Promise<Response> {
  if (output.format === "svg") return svgResponse(svg, status, maxAge);

  const png = await rasterize(svg);
  const body = png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status,
    headers: {
      ...PNG_HEADERS,
      "Cache-Control": `public, max-age=300, s-maxage=${maxAge}`,
    },
  });
}

async function defaultRasterize(svg: string): Promise<Uint8Array> {
  const { renderPng } = await import("./png");
  return renderPng(svg);
}

function landingPage(): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="embeddable activity graphs for Last.fm and GitHub.">
  <title>heatmaps</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --fg: #111;
      --secondary: #616161;
      --tertiary: #9e9e9e;
      --accent: #15803d;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #000;
        --fg: #ededed;
        --secondary: #8f8f8f;
        --tertiary: #5c5c5c;
        --accent: #4ade80;
      }
    }

    * {
      margin: 0;
      box-sizing: border-box;
    }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: .875rem;
      line-height: 1.65;
      -webkit-font-smoothing: antialiased;
    }

    main {
      max-width: 760px;
      margin: 0 auto;
      padding: 3.25rem 1.25rem 3.75rem;
    }

    h1 {
      font-size: 1rem;
      font-weight: 700;
    }

    .intro {
      margin-top: .375rem;
      color: var(--secondary);
    }

    section {
      margin-top: 2.5rem;
    }

    h2 {
      padding-bottom: .375rem;
      color: var(--tertiary);
      font-size: .6875rem;
      font-weight: 500;
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    .url-row {
      margin-top: 1rem;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      color: var(--secondary);
    }

    code {
      overflow-wrap: anywhere;
    }

    code span {
      white-space: nowrap;
    }

    button {
      flex: none;
      padding: 0;
      border: 0;
      color: var(--tertiary);
      background: none;
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      color: var(--accent);
    }

    a {
      color: var(--fg);
      text-decoration: underline;
      text-decoration-color: var(--tertiary);
      text-underline-offset: 3px;
    }

    a:hover {
      color: var(--accent);
      text-decoration-color: var(--accent);
    }

    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 2px;
    }

    figure {
      margin-top: 1.25rem;
    }

    img {
      display: block;
      width: 100%;
      height: auto;
    }

    figcaption {
      margin-top: .5rem;
      color: var(--tertiary);
      font-size: .75rem;
    }

    footer {
      margin-top: 2.5rem;
      color: var(--secondary);
      font-size: .8125rem;
    }

    @media (max-width: 640px) {
      main {
        padding-top: 2rem;
        padding-bottom: 3rem;
      }

      .url-row {
        display: block;
      }

      .url-row button {
        display: block;
        margin-top: .375rem;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>heatmaps</h1>
      <p class="intro">embeddable, matching activity graphs for last.fm and github.</p>
    </header>

    <section aria-labelledby="lastfm-label">
      <h2 id="lastfm-label">last.fm</h2>
      <div class="url-row">
        <code>https://heat.oli.boo/lastfm/<wbr><span>YOUR_USERNAME</span></code>
        <button type="button" data-copy="https://heat.oli.boo/lastfm/YOUR_USERNAME">[copy]</button>
      </div>
      <figure>
        <a href="https://heat.oli.boo/lastfm/flamboh">
          <img src="https://heat.oli.boo/lastfm/flamboh" alt="example last.fm activity graph" width="734" height="132">
        </a>
        <figcaption>example: flamboh</figcaption>
      </figure>
    </section>

    <section aria-labelledby="github-label">
      <h2 id="github-label">github</h2>
      <div class="url-row">
        <code>https://heat.oli.boo/github/<wbr><span>YOUR_USERNAME</span></code>
        <button type="button" data-copy="https://heat.oli.boo/github/YOUR_USERNAME">[copy]</button>
      </div>
      <figure>
        <a href="https://heat.oli.boo/github/flamboh">
          <img src="https://heat.oli.boo/github/flamboh" alt="example github activity graph" width="734" height="132">
        </a>
        <figcaption>example: flamboh</figcaption>
      </figure>
    </section>

    <footer>see <a href="https://github.com/flamboh/heatmaps">github</a> for more</footer>
  </main>
  <script>
    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = '[copied]';
        setTimeout(() => { button.textContent = '[copy]'; }, 1200);
      });
    });
  </script>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
