/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./views/**/*.{ejs,html}",
    "./routes/**/*.{js,jsx}",
    "./app.js",
    "./public/**/*.html",
  ],
  theme: {
    extend: {
      fontFamily: {
        markgeo: ["MarkGeo", "sans-serif"],
        mrgvlovani: ["Mrgvlovani", "sans-serif"],
        kolkha: ["MarkGeo", "sans-serif"],
      },
      colors: {
        primary: "#315EFF", // Custom blue
        secondary: "#36454F", // Custom red
      },
    },
  },
  plugins: [],
};
