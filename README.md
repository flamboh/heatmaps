# Heatmaps

Embeddable, matching GitHub-style activity graphs for Last.fm and GitHub.

```html
<img src="https://heat.oli.boo/lastfm/YOUR_USERNAME" alt="Last.fm activity" />
<img src="https://heat.oli.boo/github/YOUR_USERNAME" alt="GitHub activity" />
```
## Last.FM (https://heat.oli.boo/lastfm/flamboh?display=minimal)
<img src="https://heat.oli.boo/lastfm/flamboh?display=minimal" alt="GitHub activity" />

## GitHub (https://heat.oli.boo/github/flamboh?display=minimal)
<img src="https://heat.oli.boo/github/flamboh?display=minimal" alt="GitHub activity" />

Both sources expose the same interface:

- `GET /lastfm/:username` and `GET /github/:username` return adaptive SVGs.
- Add `.svg` for an explicit SVG URL.
- Add `.png?theme=light` or `.png?theme=dark` for a 2× PNG.
- Add `/streak` for the current America/Los_Angeles streak as `{"streak": 14}`.
- Add `/total` for the exact America/Los_Angeles period displayed by the chart as
  `{"total": 8167, "from": "2025-07-13", "to": "2026-07-15"}`. GitHub totals
  are contributions, not only commits.

All images accept `display=full|dates|minimal`. `full` includes labels, totals,
attribution, and the legend; `dates` omits the footer; `minimal` returns only the
tile grid.

## How it works

- Last.fm completed scrobbles and GitHub GraphQL `contributionCalendar` days are
  normalized into the same daily activity snapshot.
- One renderer supplies identical layouts, display modes, SVG/PNG output, and
  source-specific red or green palettes.
- Source-isolated daily aggregates are stored in Workers KV. Rendered images and
  streak and total responses are cached at the edge for six hours.

See [DEPLOY.md](DEPLOY.md) to deploy your own instance.

## License

MIT
