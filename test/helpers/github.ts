export function githubCalendarResponse(
  year: number,
  counts: Record<string, number> = {},
): Response {
  const cells: string[] = [];
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  const nextYear = new Date(date);
  nextYear.setUTCFullYear(year + 1, 0, 1);
  const daysInYear = Math.round(
    (nextYear.getTime() - date.getTime()) / 86_400_000,
  );

  for (let index = 0; index < daysInYear; index += 1) {
    const dateKey = date.toISOString().slice(0, 10);
    const id = `contribution-day-${year}-${index}`;
    const count = counts[dateKey] ?? 0;
    const label =
      count === 0
        ? "No contributions"
        : `${count.toLocaleString("en-US")} contribution${count === 1 ? "" : "s"}`;
    cells.push(
      `<td data-date="${dateKey}" id="${id}" class="ContributionCalendar-day"></td>`,
      `<tool-tip for="${id}">${label} on ${dateKey}.</tool-tip>`,
    );
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return new Response(cells.join("\n"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
