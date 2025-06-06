const express = require("express");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors()); // Allow all origins
app.use(express.json());

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


