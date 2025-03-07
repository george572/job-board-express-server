const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const db = new sqlite3.Database("./database.db");
router.use(cors());

const transporter = nodemailer.createTransport({
  service: "gmail", // or use SMTP settings
  auth: {
    user: "tbilisiairporttransfers@gmail.com",
    pass: "coco icgg nmwh pgsm",
  },
});

router.post("/", (req, res) => {
  const { job_id, user_id } = req.body;

  db.get(
    "SELECT company_email, jobName FROM jobs WHERE id = ?",
    [job_id],
    (err, job) => {
      if (err || !job) return res.status(500).json({ error: "Job not found" });
      db.get(
        "SELECT file_data, file_type FROM resumes WHERE user_id = ?",
        [user_id],
        (err, resume) => {
          if (err || !resume)
            return res.status(500).json({ error: "Resume not found" });

          db.get(
            "SELECT user_name FROM users WHERE user_uid = ?",
            [user_id],
            (err, user) => {
              if (err || !user)
                return res.status(500).json({ error: "User not found" });

              const tempFilePath = path.join(
                __dirname,
                `${user.user_name || "resume"}.${resume.file_type}`
              );
              fs.writeFileSync(tempFilePath, resume.file_data);

              const mailOptions = {
                from: "your-email@gmail.com",
                to: job.company_email,
                subject: `${job.jobName}`,
                text: `ახალი CV გამოიგზავნა თქვენს ვაკანსიაზე: "${job.jobName}"`,
                attachments: [
                  {
                    filename: `${user.user_name || "resume"}.${
                      resume.file_type
                    }`,
                    path: tempFilePath,
                  },
                ],
              };

              transporter.sendMail(mailOptions, (error, info) => {
                fs.unlinkSync(tempFilePath);
                if (error)
                  return res.status(500).json({ error: error.message });

                res.json({ message: "CV sent successfully to company email" });
              });
            }
          );
        }
      );
    }
  );
});

module.exports = router;
