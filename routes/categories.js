const cors = require("cors");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const router = express.Router();
const db = new sqlite3.Database("./database.db");
router.use(cors()); // Ensure CORS is applied to this router

router.get("/", (req, res) => {
  db.all("SELECT * FROM categories", [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!row) {
      return res.status(404).json({ error: "not found" });
    }

    res.json(row); // Return the matching user
  });
});

module.exports = router