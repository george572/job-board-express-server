const cors = require("cors");
const express = require("express");
const multer = require("multer");
const path = require("path");
const cloudinary = require("cloudinary").v2;

module.exports = function (db) {
  const router = express.Router();
  router.use(cors());

  const storage = multer.diskStorage({
    filename: (req, file, cb) => {
      const extension = path.extname(file.originalname);
      const filename = Date.now() + extension;
      cb(null, filename);
    },
  });

  const upload = multer({ storage });

  router.get("/:id", (req, res) => {
    const { id } = req.params;

    db("resumes")
      .where("user_id", id)
      .orderBy("updated_at", "desc")
      .first()
      .then((row) => {
        if (!row) {
          return res.status(404).json({ error: "Order not found" });
        }
        return res.json({
          file_url: row.file_url,
          user_id: row.user_id,
          created_at: row.created_at,
          file_name: row.file_name ? row.file_name : ''
        });
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  });

  router.post("/", upload.single("resume"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const rawName = req.file.originalname;
    const file_name = Buffer.from(rawName, "latin1").toString("utf8");
    const user_id = String(req.body.user_uid);

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

          db("resumes")
            .insert({
              file_url: downloadUrl,
              user_id: user_id,
              file_name
            })
            .then(() => {
              res.json({ message: "File uploaded successfully" });
              const { indexCandidateFromCvUrl } = require("../services/pineconeCandidates");
              const { invalidate } = require("../services/cvFitCache");
              indexCandidateFromCvUrl(user_id, downloadUrl, file_name)
                .then(() => invalidate(user_id))
                .catch((err) => console.warn("[Pinecone] Failed to index CV for user", user_id, err.message));
            })
            .catch((err) => res.status(500).json({ error: err.message }));
        }
      }
    );
  });

  router.delete("/:id", async (req, res) => {
    const userId = req.params.id;
    try {
      const count = await db("resumes").where("user_id", userId).del();
      if (count === 0) {
        return res.status(404).json({ error: "Order not found" });
      }
      const { deleteCandidate } = require("../services/pineconeCandidates");
      const { invalidate } = require("../services/cvFitCache");
      await deleteCandidate(userId).catch((err) => console.warn("[Pinecone] Failed to delete candidate", userId, err.message));
      invalidate(userId);
      res.status(200).json({ message: "CV deleted successfully" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
