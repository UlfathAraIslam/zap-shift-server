const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

// Load environment variables from .env file
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const trackingsCollection = db.collection("trackings");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    //custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.get("/users/search", async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery) {
        return res.status(400).send({ message: "Missing email query" });
      }

      const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

      try {
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          // .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray();
        res.send(users);
      } catch (error) {
        console.error("Error searching users", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });

    // Get user role by email
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1, email: 1 } },
        );

        if (!user) {
          return res.status(404).send({ role: "user" });
        }

        res.send({
          email: user.email,
          role: user.role || "user",
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to get user role" });
      }
    });

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        //TODO: update last log in info
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;

        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role" });
        }

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } },
          );
          res.send({ message: `User role updated to ${role}`, result });
        } catch (error) {
          console.error("Error updating user role", error);
          res.status(500).send({ message: "Failed to update user role" });
        }
      },
    );

    // parcels api
    // GET parcels (all OR by created_by email) - latest first
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;
        let query = {};
        if (email) {
          query = { created_by: email };
        }

        if (payment_status) {
          query.payment_status = payment_status;
        }

        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

        const options = {
          sort: { createdAt: -1 }, // Newest first
        };

        console.log("parcel query", req.query, query);

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // GET parcel by id
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };
        const parcel = await parcelsCollection.findOne(query);

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // GET: Get pending delivery tasks for a rider
    app.get("/rider/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        const query = {
          assigned_rider_email: email,
          delivery_status: { $in: ["rider_assigned", "in_transit"] },
        };

        const options = {
          sort: { creation_date: -1 }, // Newest first
        };

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching rider tasks:", error);
        res.status(500).send({ message: "Failed to get rider tasks" });
      }
    });

    // GET: Load completed parcel deliveries for a rider
    app.get(
      "/rider/completed-parcels",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;

          if (!email) {
            return res.status(400).send({ message: "Rider email is required" });
          }

          const query = {
            assigned_rider_email: email,
            delivery_status: {
              $in: ["delivered", "service_center_delivered"],
            },
          };

          const options = {
            sort: { creation_date: -1 }, // Latest first
          };

          const completedParcels = await parcelsCollection
            .find(query, options)
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          console.error("Error loading completed parcels:", error);
          res
            .status(500)
            .send({ message: "Failed to load completed deliveries" });
        }
      },
    );

    // POST: Create a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        // newParcel.createdAt = new Date();

        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    app.patch("/parcels/:id/assign", async (req, res) => {
      const parcelId = req.params.id;
      const { riderId, riderName, riderEmail } = req.body;

      try {
        // Update parcel
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "rider_assigned",
              assigned_rider_id: riderId,
              assigned_rider_name: riderName,
              assigned_rider_email: riderEmail,
            },
          },
        );

        // Update rider
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "in_delivery",
            },
          },
        );

        res.send({ message: "Rider assigned" });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to assign rider" });
      }
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const parcelId = req.params.id;
      const { status } = req.body;
      //set parcel delivery time
      const updatedDoc = {
        delivery_status: status,
      };

      if (status === "in_transit") {
        updatedDoc.picked_at = new Date().toISOString();
      } else if (status === "delivered") {
        updatedDoc.delivered_at = new Date().toISOString();
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: updatedDoc,
          },
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update status" });
      }
    });

    app.patch("/parcels/:id/cashout", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            cashout_status: "cashed_out",
            cashed_out_at: new Date(),
          },
        },
      );
      res.send(result);
    });
    // DELETE parcel by id
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };

        const result = await parcelsCollection.deleteOne(query);

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.get("/trackings/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      const updates = await trackingsCollection
        .find({ tracking_id: trackingId })
        .sort({ timestamp: 1 }) // sort by time ascending
        .toArray();

      res.json(updates);
    });

    app.post("/trackings", async (req, res) => {
      const update = req.body;

      update.timestamp = new Date(); // ensure correct timestamp
      if (!update.tracking_id || !update.status) {
        return res
          .status(400)
          .json({ message: "tracking_id and status are required." });
      }

      const result = await trackingsCollection.insertOne(update);
      res.status(201).json(result);
    });

    //riders
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    // Get all pending riders
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const result = await ridersCollection
          .find({ status: "pending" })
          .sort({ applied_at: -1 }) // newest first
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });

    // Update rider status
    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status,
        },
      };

      try {
        const result = await ridersCollection.updateOne(query, updateDoc);

        // update user role for accepting rider
        if (status === "active") {
          const userQuery = { email };
          const userUpdateDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdateDoc,
          );
          console.log(roleResult.modifiedCount);
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });
    // Get active riders
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      const riders = await ridersCollection
        .find({ status: "active" })
        .sort({ approved_at: -1 })
        .toArray();
      res.send(riders);
    });

    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;

      try {
        const riders = await ridersCollection
          .find({
            district,
            // status: { $in: ["approved", "active"] },
            // work_status: "available",
          })
          .toArray();

        res.send(riders);
      } catch (err) {
        res.status(500).send({ message: "Failed to load riders" });
      }
    });

    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status,
        },
      };

      try {
        const result = await ridersCollection.updateOne(query, updateDoc);

        // update user role for accepting rider
        if (status === "active") {
          const userQuery = { email };
          const userUpdateDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdateDoc,
          );
          console.log(roleResult.modifiedCount);
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    //Get payments
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "forbidden account" });
        }

        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } }; // Latest first

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    //POST: Record payment and update payment status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, transactionId, paymentMethod } =
          req.body;

        // 1️⃣ Update parcel payment status
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
            },
          },
        );
        if (parcelUpdate.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });
        }

        // 2️⃣ Save payment history
        const paymentDoc = {
          parcelId,
          email,
          amount,
          transactionId,
          paymentMethod,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Payment processing failed" });
      }
    });

    //payment intent
    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
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
