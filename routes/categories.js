const express = require("express");
const cors = require("cors");

module.exports = function (db) {
  const router = express.Router();
  router.use(cors());

  router.get("/", async (req, res) => {
    try {
      const rows = await db("categories").select("*");
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Categories not found" });
      }
      res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
