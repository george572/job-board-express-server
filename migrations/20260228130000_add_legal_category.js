/**
 * Add იურიდიული (Legal) category (id 27)
 * Lawyers, attorneys, legal advisors, notaries, etc.
 */
exports.up = async function (knex) {
  const exists = await knex("categories")
    .where("id", 27)
    .orWhere("name", "იურიდიული")
    .first();
  if (!exists) {
    await knex("categories").insert({ id: 27, name: "იურიდიული" });
  }
  await knex.raw(
    `SELECT setval(pg_get_serial_sequence('categories', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM categories), 27))`
  );
};

exports.down = async function (knex) {
  await knex("jobs").where("category_id", 27).update({ category_id: 19 }); // move to სხვა
  await knex("categories").where("id", 27).del();
};
