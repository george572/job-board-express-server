/**
 * One-time script: Keep the 25 most recent jobs (by created_at desc) in "today".
 * Subtract 12 hours from the rest so they show as Feb 17.
 *
 * Usage: node scripts/move-rest-to-feb17.js [--apply]
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const HOURS_TO_SUBTRACT = 12;

async function main() {
  const doApply = process.argv.includes("--apply");

  // Get all jobs currently in "today" (Feb 18 Georgia), ordered by created_at desc (most recent first)
  const inToday = await db("jobs")
    .select("id", "jobName", "created_at")
    .where("job_status", "approved")
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .whereRaw("(created_at AT TIME ZONE 'Asia/Tbilisi')::date = (NOW() AT TIME ZONE 'Asia/Tbilisi')::date")
    .orderBy("created_at", "desc");

  const KEEP_COUNT = 25;
  if (inToday.length <= KEEP_COUNT) {
    console.log(`Only ${inToday.length} jobs in today - nothing to move.`);
    await db.destroy();
    return;
  }

  // Keep first 25 (most recent); move the rest (older) to Feb 17
  const toMove = inToday.slice(KEEP_COUNT);
  console.log(`\n${toMove.length} jobs to move from today → Feb 17 (ids ${toMove[0].id}-${toMove[toMove.length - 1].id})`);
  toMove.slice(0, 3).forEach((j, i) => {
    const oldDate = new Date(j.created_at);
    const newDate = new Date(oldDate.getTime() - HOURS_TO_SUBTRACT * 60 * 60 * 1000);
    console.log(`  #${j.id} ${j.jobName} — ${oldDate.toISOString()} → ${newDate.toISOString()}`);
  });
  if (toMove.length > 3) console.log(`  ... and ${toMove.length - 3} more`);

  if (!doApply) {
    console.log("\nDry run. Run with --apply to update.");
    await db.destroy();
    return;
  }

  const ids = toMove.map((j) => j.id);
  const updated = await db("jobs")
    .whereIn("id", ids)
    .update({ created_at: db.raw(`created_at - interval '${HOURS_TO_SUBTRACT} hours'`) });

  console.log(`\nUpdated ${updated} jobs. created_at -= ${HOURS_TO_SUBTRACT} hours`);
  console.log(`Today's jobs should now show only ${KEEP_COUNT}.`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
