// Spatial helpers for a scrumblr board.
//
// Convention this module assumes:
//   - Story cards are white and contain a Jira-style id like [PROJ-123],
//     optionally followed by an estimate.
//   - Cards LEFT of a story (x < story.x) within ±ROW_PROXIMITY_PX of its y
//     are the open task breakdown. Cards to the right are done or unrelated.
//   - Row separators define horizontal bands; a card's row label is the
//     nearest separator at or above its y.
//
// The Jira project prefix matched in story cards is configurable via the
// SCRUMBLR_JIRA_PREFIX env var (default: any uppercase prefix).

export const ROW_PROXIMITY_PX = 110;

const JIRA_PREFIX = process.env.SCRUMBLR_JIRA_PREFIX || "[A-Z]+";
const JIRA_RE = new RegExp(`\\[(${JIRA_PREFIX}-\\d+)\\]`, "i");

export const num = (v) => {
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export const cardText = (c) => c?.text || "";

export const isStoryCard = (c) =>
  (c?.colour || "").toLowerCase() === "white" && JIRA_RE.test(cardText(c));

export const jiraIdOf = (c) => cardText(c).match(JIRA_RE)?.[1] ?? null;

/** Find the nearest row separator at or above `y`, returning its label. */
export function rowLabelFor(y, rows) {
  const sorted = [...rows].sort((a, b) => num(a.y) - num(b.y));
  let label = null;
  for (const r of sorted) {
    if (num(r.y) <= num(y)) label = r.text;
    else break;
  }
  return label;
}

/**
 * Cards spatially tied to `story`: x < story.x and |y - story.y| <= proximity.
 * Returned sorted left-to-right.
 */
export function clusterFor(story, allCards, proximity = ROW_PROXIMITY_PX) {
  const sx = num(story.x), sy = num(story.y);
  return allCards
    .filter((c) => c.id !== story.id && num(c.x) < sx && Math.abs(num(c.y) - sy) <= proximity)
    .sort((a, b) => num(a.x) - num(b.x));
}

export function findStory(cards, jiraId) {
  const want = jiraId.toUpperCase();
  return cards.find((c) => isStoryCard(c) && jiraIdOf(c)?.toUpperCase() === want) ?? null;
}
