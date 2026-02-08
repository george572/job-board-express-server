const express = require("express");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const path = require("path");

const app = express();
const port = process.env.PORT || 3001;

// Set up view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cors()); // Allow all origins
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Home route
app.get("/", (req, res) => {
  res.render("index");
});

cloudinary.config({
  cloud_name: "dd7gz0aqv",
  api_key: "345132216437496",
  api_secret: "gRBZZuGtsxALJlZ7sxh8SCwgTVw",
});

// jobs router
const jobsRouter = require("./routes/jobs");
app.use("/jobs", jobsRouter);

// users router
const usersRouter = require("./routes/users");
app.use("/users", usersRouter);

// resumes router
const resumesRouter = require("./routes/resumes");
app.use("/resumes", resumesRouter);

// categories router
const categoriesRouter = require("./routes/categories");
app.use("/categories", categoriesRouter);

// company logos router
const companyLogosRouter = require("./routes/company_logos");
app.use("/upload-logo", companyLogosRouter);

// send cv router
const sendCvRouter = require("./routes/sendCv");
app.use("/send-cv", sendCvRouter);

app.use("/uploads", express.static("uploads"));

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});


