const { Sequelize } = require("sequelize");

const sequelize = new Sequelize("DISCIPLINE_RULE_ENGINE", "auth", "1234", {
  host: "DESKTOP-C1F49GD",
  dialect: "mssql",
  logging: false,
  dialectOptions: {
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
  },
  pool: {
    max: 5,
    min: 0,
    idle: 30000,
  },
});

module.exports = sequelize;
