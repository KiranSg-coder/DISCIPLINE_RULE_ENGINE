require("dotenv").config();
const express = require("express");
const app = express();
const sequelizeConnection = require("./config/database");
const internalRoutes = require("./routes/internal.routes")
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Discipline rule engine running.....");
});

app.use("/internal", internalRoutes);
const PORT = process.env.PORT || 6003;

sequelizeConnection
  .authenticate()
  .then(() => {
    console.log("Database connection has been established successfully.");
    return sequelizeConnection.sync();
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on PORT ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Error occured while syncing database: ", err);
  });

  