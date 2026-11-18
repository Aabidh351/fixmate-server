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

const connectDB = await connectToMongoDB();
const db = client.db("fixmateDB");

app.get('/', (req, res)=>{
    res.send("Hello from Fixmate!");
})

app.listen(port, ()=>{
    console.log(`Listening to port ${port}...`);
})