/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./views/**/*.{ejs,html}",
    "./routes/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#315EFF",
        secondary: "#36454F",
      },
    },
  },
  plugins: [],
};
