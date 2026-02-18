/**
 * Add new job categories: მძღოლი (21), Web/Digital/Design (22), ექთანი (23), ექიმი (24), ადმინისტრატორი (25)
 */
exports.up = async function (knex) {
  const newCategories = [
    { id: 21, name: "მძღოლი" },
    { id: 22, name: "Web/Digital/Design" },
    { id: 23, name: "ექთანი" },
    { id: 24, name: "ექიმი" },
    { id: 25, name: "ადმინისტრატორი" },
  ];
  for (const cat of newCategories) {
    const exists = await knex("categories").where("id", cat.id).orWhere("name", cat.name).first();
    if (!exists) {
      await knex("categories").insert(cat);
    }
  }
  await knex.raw(
    `SELECT setval(pg_get_serial_sequence('categories', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM categories), 25))`
  );
};

exports.down = async function (knex) {
  await knex("jobs").whereIn("category_id", function () {
    this.select("id").from("categories").whereIn("name", [
      "მძღოლი",
      "Web/Digital/Design",
      "ექთანი",
      "ექიმი",
      "ადმინისტრატორი",
    ]);
  }).update({ category_id: 19 }); // move to "სხვა"
  await knex("categories")
    .whereIn("name", ["მძღოლი", "Web/Digital/Design", "ექთანი", "ექიმი", "ადმინისტრატორი"])
    .del();
};
