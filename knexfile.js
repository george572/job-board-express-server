require("dotenv").config();

module.exports = {
  // development: {
  //   client: 'pg',
  //   connection: {
  //     host: '127.0.0.1',
  //     user: 'myuser',       // your local user
  //     password: 'mypassword', // your local password
  //     database: 'mydb',      // your local database
  //   },
  // },
  development: {
    client: "pg",
    connection: {
      host: "ccaml3dimis7eh.cluster-czz5s0kz4scl.eu-west-1.rds.amazonaws.com",
      user: "ubcc3d5l45k0qm",
      password: "pc43eb9f4c1646292456193909598034d31ebd7170373e4d52522d695d29443aa",
      database: "d6vma50v9o1pmr",
    },
  },
  production: {
    client: "pg",
    connection: {
      host: "ccaml3dimis7eh.cluster-czz5s0kz4scl.eu-west-1.rds.amazonaws.com",
      user: "ubcc3d5l45k0qm",
      password: "pc43eb9f4c1646292456193909598034d31ebd7170373e4d52522d695d29443aa",
      database: "d6vma50v9o1pmr",
    },
  },
};
