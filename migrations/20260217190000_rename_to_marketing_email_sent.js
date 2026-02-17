/**
 * Rename general_marketing_email_sent to marketing_email_sent.
 */
exports.up = async function (knex) {
  const hasOld = await knex.schema.hasColumn("jobs", "general_marketing_email_sent");
  const hasNew = await knex.schema.hasColumn("jobs", "marketing_email_sent");
  if (hasOld && !hasNew) {
    await knex.schema.alterTable("jobs", (table) => {
      table.renameColumn("general_marketing_email_sent", "marketing_email_sent");
    });
  } else if (!hasOld && !hasNew) {
    await knex.schema.alterTable("jobs", (table) => {
      table.boolean("marketing_email_sent").defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  const hasNew = await knex.schema.hasColumn("jobs", "marketing_email_sent");
  if (hasNew) {
    await knex.schema.alterTable("jobs", (table) => {
      table.renameColumn("marketing_email_sent", "general_marketing_email_sent");
    });
  }
};
