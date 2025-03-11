const express = require("express");
const cors = require("cors");
const knex = require("knex");
const router = express.Router();

// Set up knex for PostgreSQL
const db = knex(require("../knexfile").development); // Assuming you're using 'development' from knexfile.js

router.use(cors()); // Ensure CORS is applied to this router

router.get("/", async (req, res) => {
  try {
    const rows = await db("categories").select("*"); // Fetch categories from PostgreSQL
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Categories not found" });
    }
    res.json(rows);
    console.log(rows) // Return the categories
  } catch (err) {
    return res.status(500).json({ error: err.message }); // Return error if query fails
  }
});

module.exports = router;