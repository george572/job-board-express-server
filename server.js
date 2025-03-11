const express = require("express");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;

const app = express();
const port = process.env.PORT || 3000;

const knex = require("knex");
const db = knex(require("./knexfile").development); 

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

const categories = [
  "გაყიდვები",
  "მენეჯმენტი",
  "ინფორმაციული ტექნოლოგიები",
  "ტურიზმი",
  "სამედიცინო",
  "საბანკო-საფინანსო",
  "საწყობი",
  "დისტრიბუცია",
  "აზარტული",
  "უსაფრთხოება",
  "მზარეული",
  "მოლარე",
  "დრაივები",
  "მარკეტინგი",
  "ბუღალტერია",
  "ლოჯისტიკა",
  "ადმინისტრაცია",
  "კურიერი",
  "ფინანსები",
  "ავტოინდუსტრია",
  "მშენებლობა",
  "ინჟინერია",
  "ადამიანური რესურსები",
  "ფარმაცია",
  "პროექტების მენეჯმენტი",
  "სხვა",
];

db('categories')
  .insert(categories.map(name => ({ name })))
  .then(() => console.log('Categories inserted successfully'))
  .catch((err) => console.error('Error inserting categories:', err));

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});


