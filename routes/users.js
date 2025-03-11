const cors = require("cors");
const express = require("express");
const knex = require("knex");
const router = express.Router();
const db = knex(require("../knexfile").development);  // assuming knexfile.js is configured properly

router.use(cors()); // Ensure CORS is applied to this router

// Check if user exists using Knex
const checkIfUserExists = (uid) => {
  return db("users").where("user_uid", uid).first();
};

// Route to get a user
router.get("/:id", (req, res) => {
  const { id } = req.params; // Get the `id` from the route parameter

  db("users")
    .where("user_uid", id)
    .first()
    .then((row) => {
      if (!row) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json(row); // Return the matching user
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// Signup/login user
router.post("/auth", (req, res) => {
  const { user_uid, user_name, user_email, user_type } = req.body;

  // Validate input
  if (!user_uid || !user_name || !user_email || !user_type) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // First check if user exists
  checkIfUserExists(user_uid)
    .then((existingUser) => {
      if (existingUser) {
        return res.status(201).json({ exists: true, user: existingUser });
      }

      // If user does not exist, add it to the database
      db("users")
        .insert({
          user_uid,
          user_name,
          user_email,
          user_type,
        })
        .then(() => {
          res.status(201).json({
            user_uid,
            user_name,
            user_email,
            user_type,
          });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// Update user details
router.patch("/:id", (req, res) => {
  const userId = req.params.id; // Get the user ID from the URL parameter
  const userData = req.body; // Get the updated data from the request body

  // Validate that at least one field is provided for update
  if (Object.keys(userData).length === 0) {
    return res.status(400).json({ error: "No fields provided to update" });
  }

  // Dynamically build the update query
  const updateFields = ["user_uid", "user_name", "user_email", "user_type"];
  const updateData = {};

  // Build dynamic update fields
  updateFields.forEach((field) => {
    if (userData[field]) {
      updateData[field] = userData[field];
    }
  });

  // If no valid fields are provided, return an error
  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  db("users")
    .where("user_uid", userId)
    .update(updateData)
    .then((count) => {
      if (count === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.status(200).json({ message: "User updated successfully" });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

module.exports = router;
