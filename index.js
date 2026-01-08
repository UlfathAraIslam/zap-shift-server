const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

// middleware
app.use(cors());
app.use(express.json());



// test route
app.get("/", (req, res) => {
  res.send("Parcel server is running 🚚");
});


// port
const PORT = process.env.PORT || 5000;

// start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
