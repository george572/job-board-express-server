module.exports = {
  proxy: "localhost:3001", // your Express port
  files: ["public/**/*", "views/**/*"],
  port: 3001, // browser-sync will run on this port
  open: false,
  notify: false
};