const RECOMMENDED_CATEGORY_ID = 9999;

exports.up = function (knex) {
  return knex
    .raw(
      `INSERT INTO categories (id, name) VALUES (?, 'შენთვის რეკომენდებული ვაკანსიები')
       ON CONFLICT (id) DO NOTHING`,
      [RECOMMENDED_CATEGORY_ID]
    )
    .then(() =>
      knex.raw(
        `SELECT setval(pg_get_serial_sequence('categories', 'id'), COALESCE((SELECT MAX(id) FROM categories), 1))`
      )
    );
};

exports.down = function (knex) {
  return knex("categories").where("id", RECOMMENDED_CATEGORY_ID).del();
};
