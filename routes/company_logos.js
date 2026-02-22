const express = require("express");
const multer = require("multer");
const path = require("path");
const cloudinary = require("cloudinary").v2;

module.exports = function (db) {
  const router = express.Router();

  const storage = multer.diskStorage({
    filename: (req, file, cb) => {
      const extension = path.extname(file.originalname);
      const filename = Date.now() + extension;
      cb(null, filename);
    },
  });

  const upload = multer({ storage });

  router.post("/", upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const jobId = req.body.job_id;

    cloudinary.uploader.upload(req.file.path, function (error, result) {
      if (error) {
        return res.status(500).json({ error: error.message });
      } else {
        db("company_logos")
          .insert({
            secure_url: result.secure_url,
            job_id: jobId,
          })
          .returning("id")
          .then(([id]) => {
            res.json({ id });
          })
          .catch((err) => {
            res.status(500).json({ error: err.message });
          });
      }
    });
  });

  router.get("/:job_id", (req, res) => {
    const job_id = req.params.job_id;
    db("company_logos")
      .select("secure_url")
      .where("job_id", job_id)
      .orderBy("id", "desc")
      .limit(1)
      .then((rows) => {
        if (rows.length === 0) return res.status(404).json({ error: "No logo found" });
        const image = rows[0].secure_url;
        res.json({ image });
      })
      .catch((err) => {
        res.status(500).json({ error: err.message });
      });
  });

  return router;
};
