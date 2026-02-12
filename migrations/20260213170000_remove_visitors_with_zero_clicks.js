exports.up = async function (knex) {
  await knex.raw(`
    DELETE FROM visitors
    WHERE id IN (
      SELECT v.id FROM visitors v
      LEFT JOIN (
        SELECT visitor_id, COUNT(*) as cnt
        FROM visitor_job_clicks
        GROUP BY visitor_id
      ) c ON v.id = c.visitor_id
      WHERE COALESCE(c.cnt, 0) < 2
    )
  `);
};

exports.down = function () {
  return Promise.resolve();
};
