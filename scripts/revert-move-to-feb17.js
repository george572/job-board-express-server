/**
 * Revert: Add 12 hours back to jobs 585-625 that we wrongly moved to Feb 17.
 * They were uploaded at 00:30 Feb 18 Georgia and should show Feb 18.
 *
 * Usage: node scripts/revert-move-to-feb17.js [--apply]
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const IDS = [585,586,587,588,589,590,591,592,593,594,595,596,597,598,599,600,601,602,603,604,605,606,607,608,609,610,611,612,613,614,615,616,617,618,619,620,621,622,623,624,625];

async function main() {
  const doApply = process.argv.includes("--apply");
  const jobs = await db("jobs").select("id","jobName","created_at").whereIn("id", IDS);
  console.log(`\nRevert: add 12h back to ${jobs.length} jobs (uploaded ~00:30 Feb 18 Georgia)`);
  jobs.slice(0,2).forEach(j => console.log(`  #${j.id} ${j.jobName} — ${j.created_at}`));

  if (!doApply) {
    console.log("\nDry run. Run with --apply to update.");
    await db.destroy();
    return;
  }
  const updated = await db("jobs").whereIn("id", IDS).update({
    created_at: db.raw("created_at + interval '12 hours'")
  });
  console.log(`\nReverted ${updated} jobs. They will show as Feb 18 again.`);
  await db.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
