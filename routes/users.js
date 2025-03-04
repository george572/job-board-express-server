const cors = require("cors");
const express = require("express");
const router = express.Router();
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./database.db");

router.use(cors()); // Ensure CORS is applied to this router

// Check if user exists - using callback pattern
const checkIfUserExists = (uid, callback) => {
  db.get("SELECT * FROM users WHERE user_uid = ?", [uid], (err, row) => {
    if (err) {
      return callback(err, null);
    }
    callback(null, row);
  });
};

// Route to get a user
router.get("/:id", (req, res) => {
  const { id } = req.params; // Get the `id` from the route parameter

  db.get("SELECT * FROM users WHERE user_uid = ?", [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!row) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(row); // Return the matching user
  });
});

// signup/login user
router.post("/auth", (req, res) => {
  const { user_uid, user_name, user_email, user_type } = req.body;

  // Validate input
  if (!user_uid || !user_name || !user_email || !user_type) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // First check if user exists
  checkIfUserExists(user_uid, (err, existingUser) => {
    if (err) {
      console.error("Error checking if user exists:", err);
      return res.status(500).json({ error: err.message });
    }

    if (existingUser) {
      return res.status(201).json({ exists: true, user: existingUser });
    }

    // If user does not exist, add it to the database
    db.run(
      "INSERT INTO users (user_uid, user_name, user_email, user_type) VALUES (?, ?, ?, ?)",
      [user_uid, user_name, user_email, user_type],
      function (err) {
        if (err) {
          console.error("Error in db.run:", err.message);
          return res.status(500).json({ error: err.message });
        }

        res.status(201).json({
          user_uid,
          user_name,
          user_email,
          user_type,
        });
      }
    );
  });
});

router.patch("/:id", (req, res) => {
  const userId = req.params.id; // Get the order ID from the URL parameter
  const userData = req.body; // Get the updated data from the request body

  // Validate that at least one field is provided for update
  if (Object.keys(userData).length === 0) {
    return res.status(400).json({ error: "No fields provided to update" });
  }

  // Dynamically build the update query
  const columns = [];
  const values = [];

  // Define the fields you want to allow updates for
  const updateFields = ["user_uid", "user_name", "user_email", "user_type"];

  // Build dynamic columns and values for the query
  updateFields.forEach((field) => {
    if (userData[field]) {
      columns.push(`${field} = ?`);
      values.push(userData[field]);
    }
  });

  // If no valid fields are provided, return an error
  if (columns.length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  // Add the order ID to the end of the values array for the WHERE clause
  values.push(userId);

  // Create the dynamic SQL query
  const query = `UPDATE users SET ${columns.join(", ")} WHERE user_uid = ?`;

  // Execute the query
  db.run(query, values, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // If no rows were updated, the order might not exist
    if (this.changes === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Respond with success
    res.status(200).json({ message: "User updated successfully" });
  });
});
module.exports = router;
