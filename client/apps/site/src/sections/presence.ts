/** Live cursors: the whole team reading an article at once, drawn by the real PresenceLayer (pointers, selections, faces). */
import { $ } from "../lib/dom";
import { TEAM } from "../lib/people";
import { pick, random, reducedMotion, scene } from "../lib/scene";
import { Stage } from "../lib/stage";

/** Phrases people select while they read, by paragraph. */
const PHRASES: [string, string][] = [
  ["#pr-h", "fastest known time"],
  ["#pr-p1", "the trailhead is silent"],
  ["#pr-p1", "that knot is the only thing you'll still trust"],
  ["#pr-p2", "salted potatoes"],
  ["#pr-p2", "The Ridge 30L carried all of it"],
  ["#pr-p3", "the whole valley opened up below us"],
];
const BLOCKS = ["#pr-h", "#pr-p1", "#pr-h4", "#pr-p2", "#pr-p3"];

export function presence(): void {
  const stage = new Stage($("#presence-page"), { avatars: true });
  const cursors = TEAM.map((person) => stage.person(person));
  const selecting = new Set<string>();

  scene($("#presence"), async (ctx) => {
    await Promise.all(cursors.map(async (cursor, i) => {
      await ctx.sleep(i * 500);
      const until = performance.now() + (reducedMotion ? 0 : 22_000);
      do {
        const free = PHRASES.filter(([block]) => !selecting.has(block));
        if (Math.random() < 0.3 && free.length) {
          const [block, phrase] = pick(free);
          selecting.add(block);
          await cursor.select(ctx, $(block), phrase);
          await ctx.sleep(random(1800, 3200));
          cursor.clearSelection();
          selecting.delete(block);
          continue;
        }
        await cursor.moveTo(ctx, { el: $(pick(BLOCKS)), x: random(0.05, 0.95), y: random(0.1, 0.9) }, random(1100, 2200));
        await ctx.sleep(random(300, 1800));
      } while (performance.now() < until);
    }));
  }, { gap: 200 });
}
