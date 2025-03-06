const express = require("express");
const router = express.Router();
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./database.db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
  destination: "uploads/", // Store the files in the uploads folder
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname); // Get the file extension
    const filename = Date.now() + extension; // Use timestamp as the filename for uniqueness
    cb(null, filename); // Assign the filename
  },
});

const upload = multer({ storage });

// POST route for uploading images
router.post("/", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filename = req.file.filename; // Get the uploaded filename
  const userUid = req.body.user_uid; // Get the user_uid from the request body

  // Insert the filename into the database with the user_uid
  db.run(
    "INSERT INTO company_logos (filename, user_uid) VALUES (?, ?)",
    [filename, userUid],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      // Return the filename in the response (for later use)
      res.json({ id: this.lastID, filename });
    }
  );
});

router.get("/:user_uid", (req, res) => {
  const userUid = req.params.user_uid;

  db.get(
    "SELECT filename FROM company_logos WHERE user_uid = ? ORDER BY id DESC LIMIT 1",
    [userUid],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "No logo found" });

      // Construct the URL to the image file
      const imageUrl = `http://localhost:3000/uploads/${row.filename}`;
      res.json({ imageUrl });
    }
  );
});

module.exports = router;
