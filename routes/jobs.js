const cors = require("cors");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const router = express.Router();
const db = new sqlite3.Database("./database.db");
router.use(cors()); // Ensure CORS is applied to this router

// Route to get all jobs
router.get("/", (req, res) => {
  const { category, company, page = 1, limit = 10 } = req.query;

  const offset = (page - 1) * limit;
  let query = "SELECT * FROM jobs";
  let params = [];

  // If a company filter is provided, add to the query
  if (company) {
    query += " WHERE companyName = ?";
    params.push(company);
  }

  // If a category filter is provided, add to the query
  if (category) {
    if (params.length > 0) {
      query += " AND category_id = ?";
    } else {
      query += " WHERE category_id = ?";
    }
    params.push(category);
  }

  // Add pagination to the query
  query += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Get total count of jobs (considering the company and category filters)
    let countQuery = "SELECT COUNT(*) AS totalItems FROM jobs";
    let countParams = [];

    if (company) {
      countQuery += " WHERE companyName = ?";
      countParams.push(company);
    }

    if (category) {
      if (countParams.length > 0) {
        countQuery += " AND category_id = ?";
      } else {
        countQuery += " WHERE category_id = ?";
      }
      countParams.push(category);
    }

    db.get(countQuery, countParams, (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      const totalItems = result.totalItems;
      const totalPages = Math.ceil(totalItems / limit);

      res.json({
        data: rows,
        totalItems,
        totalPages,
        currentPage: page,
      });
    });
  });
});

//search jobs
router.get('/search', (req, res) => {
  const searchTerm = req.query.q; // Query parameter 'q' for search
  
  if (!searchTerm) {
    return res.status(400).send('Search term is required');
  }
  
  const query = `SELECT * FROM jobs WHERE jobName LIKE ?`;
  const searchQuery = `%${searchTerm}%`; // SQL wildcards for partial match

  db.all(query, [searchQuery], (err, rows) => {
    if (err) {
      return res.status(500).send('Error querying database');
    }

    res.json(rows); // Respond with search results
  });
});

// get all jobs for particular company
router.get("/company/:id", (req, res) => {
  db.all(
    "SELECT * FROM jobs where user_uid = ?",
    [req.params.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      return res.json(rows);
    }
  );
});
// Route to get a specific order by ID
router.get("/:id", (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM jobs WHERE id = ?", [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json(row);
  });
});

// create new job
router.post("/", async (req, res) => {
  const {
    companyName,
    jobName,
    jobSalary,
    jobDescription,
    jobExperienceRequired,
    jobIsUrgent,
    user_uid,
    category_id, // Add category_id to the payload
  } = req.body;

  // Validate input
  if (
    !companyName ||
    !jobName ||
    !jobSalary ||
    !jobDescription ||
    jobExperienceRequired === undefined ||
    jobIsUrgent === undefined ||
    !user_uid ||
    !category_id // Check if category_id is provided
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Insert data into the jobs table
  const query = `INSERT INTO jobs (
                companyName,
                jobName,
                jobSalary,
                jobDescription,
                jobExperienceRequired,
                jobIsUrgent,
                user_uid,
                category_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(
    query,
    [
      companyName,
      jobName,
      jobSalary,
      jobDescription,
      jobExperienceRequired,
      jobIsUrgent,
      user_uid,
      category_id, // Include category_id value
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({ message: "Job created", jobId: this.lastID });
    }
  );
});

// PATCH route to update an order
router.patch("/:id", (req, res) => {
  const orderId = req.params.id; // Get the order ID from the URL parameter
  const orderData = req.body; // Get the updated data from the request body

  // Validate that at least one field is provided for update
  if (Object.keys(orderData).length === 0) {
    return res.status(400).json({ error: "No fields provided to update" });
  }

  // Dynamically build the update query
  const columns = [];
  const values = [];

  // Define the fields you want to allow updates for
  const updateFields = [
    "companyName",
    "jobName",
    "jobSalary",
    "jobDescription",
    "jobExperienceRequired",
    "jobIsUrgent",
    "user_uid",
  ];

  // Build dynamic columns and values for the query
  updateFields.forEach((field) => {
    if (orderData[field]) {
      columns.push(`${field} = ?`);
      values.push(orderData[field]);
    }
  });

  // If no valid fields are provided, return an error
  if (columns.length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  // Add the order ID to the end of the values array for the WHERE clause
  values.push(orderId);

  // Create the dynamic SQL query
  const query = `UPDATE jobs SET ${columns.join(", ")} WHERE id = ?`;

  // Execute the query
  db.run(query, values, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // If no rows were updated, the order might not exist
    if (this.changes === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Respond with success
    res.status(200).json({ message: "Order updated successfully" });
  });
});

// DELETE route to remove an order
router.delete("/:id", (req, res) => {
  const orderId = req.params.id; // Get the order ID from the URL parameter

  // Create the SQL query to delete the order
  const query = `DELETE FROM jobs WHERE id = ?`;

  // Execute the query
  db.run(query, [orderId], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // If no rows were deleted, the order might not exist
    if (this.changes === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Respond with success
    res.status(200).json({ message: "Order deleted successfully" });
  });
});
module.exports = router;
