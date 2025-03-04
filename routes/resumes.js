const cors = require("cors");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const router = express.Router();
const db = new sqlite3.Database("./database.db");
const multer = require("multer");
router.use(cors()); // Ensure CORS is applied to this router

const upload = multer();

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
    const file_data_base64 = row.file_data.toString("base64");

    // Send the row data (including file_data) as a JSON response
    res.json({
      file_name: row.file_name,
      file_data: file_data_base64, // Send file_data as base64
      user_id: row.user_id,
      created_at: row.created_at,
    });
  });
});

// POST endpoint for file upload
router.post("/", upload.single("resume"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const file = req.file.buffer; // Get the file as binary data (BLOB)
  const fileName = req.file.originalname;
  const user_id = String(req.body.user_uid);
  const file_type = String(req.body.file_type);
  // Insert the file into the SQLite database
  db.run(
    "INSERT INTO resumes (file_name, file_data, user_id, file_type) VALUES (?, ?, ?, ?)",
    [fileName, file, String(user_id), file_type],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ message: "File uploaded successfully" });
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
