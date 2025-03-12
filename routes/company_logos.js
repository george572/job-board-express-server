const express = require("express");
const router = express.Router();
const knex = require("knex");
const multer = require("multer");
const path = require("path");
const cloudinary = require("cloudinary").v2;

// Set up knex for PostgreSQL
const db = knex(require("../knexfile").development); // Assuming you're using 'development' from knexfile.js

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

  const jobId = req.body.job_id; // Get the user_uid from the request body

  cloudinary.uploader.upload(req.file.path, function (error, result) {
    if (error) {
      return res.status(500).json({ error: error.message });
    } else {
      // Insert the filename into the PostgreSQL database with the user_uid
      db("company_logos")
        .insert({
          secure_url: result.secure_url,
          job_id: jobId,
        })
        .returning("id")
        .then(([id]) => {
          // Return the id of the new record
          res.json({ id });
        })
        .catch((err) => {
          res.status(500).json({ error: err.message });
        });
    }
  });
});

// GET route for fetching the latest logo by user_uid
router.get("/:user_uid", (req, res) => {
  const userUid = req.params.user_uid;

  db("company_logos")
    .select("secure_url")
    .where("user_uid", userUid)
    .orderBy("id", "desc")
    .limit(1)
    .then((rows) => {
      if (rows.length === 0) return res.status(404).json({ error: "No logo found" });

      // Return the logo URL
      const image = rows[0].secure_url;
      res.json({ image });
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
});

module.exports = router;