// Read-side projections over a BoardSnapshot. Pure functions: no I/O.

import { cardText, clusterFor, findStory, isStoryCard, num, rowLabelFor } from "./board-utils.js";

const SUMMARY_TEXT_TRUNCATE = 100;

export function searchCards(snap, query) {
  const q = query.toLowerCase();
  return snap.cards
    .filter((c) => cardText(c).toLowerCase().includes(q))
    .map((c) => ({
      id: c.id,
      text: c.text,
      colour: c.colour,
      x: num(c.x),
      y: num(c.y),
      row: rowLabelFor(c.y, snap.rows),
      isStory: isStoryCard(c),
    }));
}

export function summarize(snap) {
  const groups = new Map();
  for (const r of snap.rows) groups.set(r.text, []);
  groups.set(null, []); // anything above the topmost separator

  for (const c of snap.cards) {
    const label = rowLabelFor(c.y, snap.rows);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(c);
  }

  const lines = [
    `Board: ${snap.board}    Fetched: ${snap.fetchedAt}`,
    `Cards: ${snap.cards.length}   Rows: ${snap.rows.length}   Users connected: ${snap.users.length}`,
    "",
  ];
  for (const [label, cards] of groups) {
    if (!cards.length) continue;
    cards.sort((a, b) => num(a.y) - num(b.y) || num(a.x) - num(b.x));
    lines.push(`## ${label ?? "(above first row)"} (${cards.length} cards)`);
    for (const c of cards) {
      const tag = isStoryCard(c) ? "STORY " : "      ";
      const text = cardText(c).replace(/\s+/g, " ").slice(0, SUMMARY_TEXT_TRUNCATE);
      lines.push(`  ${tag}[${(c.colour || "?").padEnd(6)}] ${text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function storyCluster(snap, jira) {
  const story = findStory(snap.cards, jira);
  if (!story) return { error: `no story card found for ${jira}` };
  const cluster = clusterFor(story, snap.cards);
  return {
    story: {
      id: story.id,
      jira,
      text: story.text,
      x: num(story.x),
      y: num(story.y),
      row: rowLabelFor(story.y, snap.rows),
    },
    openTasks: cluster.map((c) => ({
      id: c.id,
      text: c.text,
      colour: c.colour,
      x: num(c.x),
      y: num(c.y),
    })),
  };
}
