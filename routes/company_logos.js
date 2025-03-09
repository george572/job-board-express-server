const express = require("express");
const router = express.Router();
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./database.db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cloudinary = require("cloudinary").v2;

const storage = multer.diskStorage({
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname); // Get the file extension
    const filename = Date.now() + extension; // Use timestamp as the filename for uniqueness
    cb(null, filename); // Assign the filename
  },
});

const upload = multer({ storage });

// POST route for uploading images
router.post("/", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const userUid = req.body.user_uid; // Get the user_uid from the request body

  cloudinary.uploader.upload(req.file.path, function (error, result) {
    if (error) {
      return res.status(500).json({ error: error.message });
    } else {
      // Insert the filename into the database with the user_uid
      db.run(
        "INSERT INTO company_logos (secure_url, user_uid) VALUES (?, ?)",
        [result.secure_url, userUid],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          // Return the filename in the response (for later use)
          res.json({ id: this.lastID });
        }
      );
    }
  });
});

router.get("/:user_uid", (req, res) => {
  const userUid = req.params.user_uid;

  db.get(
    "SELECT secure_url FROM company_logos WHERE user_uid = ? ORDER BY id DESC LIMIT 1",
    [userUid],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "No logo found" });

      // Construct the URL to the image file
      const image = row.secure_url
      res.json({ image });
    }
  );
});

module.exports = router;
