const APP_NAME = 'ShipBench Radar';

/**
 * The browser tab's title, which is what you see of Radar while working in
 * another window:
 * - at rest, `{project} | ShipBench Radar`
 * - for a few seconds after a change arrives while the window is in the
 *   background, `↻ {changed project} updated | ShipBench Radar`
 * - then, while changes are unseen, `● {project} | …`, with a count once
 *   more than one project has changed: `● (3) {project} | …`
 *
 * "Unseen" counts projects whose tab has a change dot, plus the open
 * project if it changed while the window was in the background.
 */
export function titleFor({
  label,
  unseen,
  flash,
}: {
  label: string | null;
  unseen: number;
  flash: string | null;
}): string {
  if (flash) return `↻ ${flash} updated | ${APP_NAME}`;
  const base = label ? `${label} | ${APP_NAME}` : APP_NAME;
  if (unseen === 0) return base;
  return unseen === 1 ? `● ${base}` : `● (${unseen}) ${base}`;
}
