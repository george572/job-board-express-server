const cors = require("cors");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const router = express.Router();
const db = new sqlite3.Database("./database.db");
const multer = require("multer");
const path = require("path");

router.use(cors()); // Ensure CORS is applied to this router
const cloudinary = require("cloudinary").v2;

const storage = multer.diskStorage({
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname); // Get the file extension
    const filename = Date.now() + extension; // Use timestamp as the filename for uniqueness
    cb(null, filename); // Assign the filename
  },
});

const upload = multer({ storage });

// get user CV
router.get("/:id", (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM resumes WHERE user_id = ?", [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }
    // Set the appropriate headers for the file

    // Send the row data (including file_data) as a JSON response
    return res.json({
      file_url: row.file_url,
      user_id: row.user_id,
      created_at: row.created_at,
    });
  });
});

// POST endpoint for file upload
router.post("/", upload.single("resume"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const user_id = String(req.body.user_uid);

  // cloudinary
  cloudinary.uploader.upload(
    req.file.path,
    {
      resource_type: "raw",
      folder: "resumes",
      use_filename: true,
      unique_filename: true,
      access_mode: "public",
    },
    function (error, result) {
      if (error) {
        return res.status(500).json({ error: error.message });
      } else {
        const downloadUrl = cloudinary.url(result.public_id, {
          resource_type: "raw",
          type: "upload",
          flags: "attachment",
        });
        // Insert the filename into the database with the user_uid
        // Insert the file into the SQLite database
        db.run(
          "INSERT INTO resumes (file_url, user_id) VALUES (?, ?)",
          [downloadUrl, String(user_id)],
          (err) => {
            if (err) {
              return res.status(500).json({ error: err.message });
            }
            res.json({ message: "File uploaded successfully" });
          }
        );
      }
    }
  );
});

// DELETE cv file
router.delete("/:id", (req, res) => {
  const userId = req.params.id; // Get the order ID from the URL parameter

  // Create the SQL query to delete the order
  const query = `DELETE FROM resumes WHERE user_id = ?`;

  // Execute the query
  db.run(query, [userId], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // If no rows were deleted, the order might not exist
    if (this.changes === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Respond with success
    res.status(200).json({ message: "CV deleted successfully" });
  });
});
module.exports = router;
