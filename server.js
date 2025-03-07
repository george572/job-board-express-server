const express = require("express");
const cors = require("cors")

const app = express();
const db = require('./dbSetup'); // Import dbSetup to run the DB initialization

app.use(cors()); // Allow all origins
app.use(express.json());

// jobs router
const jobsRouter = require("./routes/jobs");
app.use('/jobs', jobsRouter)

// users router
const usersRouter = require("./routes/users");
app.use('/users', usersRouter)

// resumes router
const resumesRouter = require("./routes/resumes")
app.use("/resumes", resumesRouter)

// categories router
const categoriesRouter = require("./routes/categories")
app.use("/categories", categoriesRouter)

// company logos router
const companyLogosRouter = require("./routes/company_logos")
app.use("/upload-logo", companyLogosRouter)

// send cv router
const sendCvRouter = require("./routes/sendCv")
app.use("/send-cv", sendCvRouter)

app.use("/uploads", express.static("uploads"));

app.listen(3000);

