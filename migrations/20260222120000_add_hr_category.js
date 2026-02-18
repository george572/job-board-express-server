/**
 * Add HR category (id 26)
 */
exports.up = async function (knex) {
  const exists = await knex("categories").where("id", 26).orWhere("name", "HR").first();
  if (!exists) {
    await knex("categories").insert({ id: 26, name: "HR" });
  }
  await knex.raw(
    `SELECT setval(pg_get_serial_sequence('categories', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM categories), 26))`
  );
};

exports.down = async function (knex) {
  await knex("jobs").where("category_id", 26).update({ category_id: 19 });
  await knex("categories").where("id", 26).del();
};
