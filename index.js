const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.y16wuc0.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB"); // database name
    const parcelCollection = db.collection("parcels"); // collection

    app.get("/parcels", async (req, res) => {
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });

    // parcels api
    // GET parcels (all OR by created_by email) - latest first
    app.get("/parcel", async (req, res) => {
      try {
        const email = req.query.email;

        // if email exists → get user's parcels
        // if not → get all parcels
        const query = email ? { created_by: email } : {};

        const parcels = await parcelCollection
          .find(query)
          .sort({ createdAt: -1 }) // latest first
          .toArray();

        res.send(parcels);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // GET parcel by id
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };
        const parcel = await parcelCollection.findOne(query);

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // POST: Create a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        // newParcel.createdAt = new Date();

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    // DELETE parcel by id
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };

        const result = await parcelCollection.deleteOne(query);

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Sample route
app.get("/", (req, res) => {
  res.send("Parcel Server is running");
});

// Start the server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
