import express from "express";
import cors from "cors";
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGO_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  }
}

await connectToMongoDB();
const db = client.db("fixmateDB");

app.get('/', (req, res)=>{
    res.send("Hello from Fixmate!");
});

app.get("/api/services/featured", async (req, res) => {
  try {
    const services = await db.collection("services")
      .find({
        approvalStatus: "approved",
        isAvailable: true,
      })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.send(services);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch featured services." });
  }
});


app.get("/api/services", async (req, res) => {
  try {
    const { search, category, serviceMode, sort } = req.query;

    const filter = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    if (category && category !== "All") {
      filter.category = category;
    }

    if (serviceMode && serviceMode !== "All") {
      filter.serviceMode = serviceMode;
    }

    if (search) {
      const searchRegex = new RegExp(
        String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );

      filter.$or = [
        { title: searchRegex },
        { category: searchRegex },
        { description: searchRegex },
      ];
    }

    let sortOption = { createdAt: -1 };

    if (sort === "price-low") {
      sortOption = { basePrice: 1 };
    } else if (sort === "price-high") {
      sortOption = { basePrice: -1 };
    }

    const services = await db
      .collection("services")
      .find(filter)
      .sort(sortOption)
      .toArray();

    res.send(services);
  } catch (error) {
    console.error("Services fetch error:", error);
    res.status(500).send({ message: "Failed to fetch services." });
  }
});


app.listen(port, ()=>{
    console.log(`Listening to port ${port}...`);
});

export default app;