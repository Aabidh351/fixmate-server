import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from "jose";

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

const authBaseURL = process.env.BETTER_AUTH_URL;

if (!authBaseURL) {
  throw new Error("BETTER_AUTH_URL is not configured.");
}

const JWKS = createRemoteJWKSet(
  new URL("/api/auth/jwks", authBaseURL)
);

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({
        message: "Unauthorized. Token required.",
      });
    }

    const token = authHeader.split(" ")[1];

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: authBaseURL,
      audience: authBaseURL,
    });

    if (
      !payload.id ||
      !payload.email ||
      !["customer", "technician", "admin"].includes(payload.role)
    ) {
      return res.status(401).send({
        message: "Invalid token payload.",
      });
    }

    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
    };

    next();
  } catch (error) {
    return res.status(401).send({
      message: "Invalid or expired token.",
    });
  }
};

const verifyCustomer = (req, res, next) => {
  if (req.user.role !== "customer") {
    return res.status(403).send({
      message: "Access denied. Customers only.",
    });
  }

  next();
};



const verifyTechnician = (req, res, next) => {
  if (req.user.role !== "technician") {
    return res.status(403).send({
      message: "Access denied. Technicians only.",
    });
  }

  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).send({
      message: "Access denied. Admins only.",
    });
  }

  next();
};

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
      filter.category = {
        $regex: `^${String(category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      };
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

app.get("/api/services/:id", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid service ID." });
    }

    const service = await db.collection("services").findOne({
      _id: new ObjectId(req.params.id),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res.status(404).send({ message: "Service not found." });
    }

    const technician = await db.collection("users").findOne(
      { email: service.technicianEmail },
      {
        projection: {
          name: 1,
          image: 1,
          area: 1,
          bio: 1,
        },
      }
    );

    res.send({
      ...service,
      technician: technician
        ? {
            name: technician.name,
            image: technician.image,
            area: technician.area,
            bio: technician.bio,
          }
        : null,
    });
  } catch (error) {
    console.error("Service fetch error:", error);
    res.status(500).send({ message: "Failed to fetch service." });
  }
});


app.post("/api/bookings", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const {
      serviceId,
      phone,
      address,
      preferredDate,
      problemDescription,
    } = req.body;

    if (
      !serviceId ||
      !phone?.trim() ||
      !address?.trim() ||
      !preferredDate ||
      !problemDescription?.trim()
    ) {
      return res.status(400).send({
        message: "Please provide all required booking information.",
      });
    }

    if (!ObjectId.isValid(serviceId)) {
      return res.status(400).send({
        message: "Invalid service ID.",
      });
    }

    if (problemDescription.trim().length < 20) {
      return res.status(400).send({
        message: "Problem description must be at least 20 characters.",
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(preferredDate) ||
      preferredDate < today ||
      Number.isNaN(Date.parse(preferredDate))
    ) {
      return res.status(400).send({
        message: "Preferred date must be today or a future date.",
      });
    }

    const service = await db.collection("services").findOne({
      _id: new ObjectId(serviceId),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res.status(404).send({
        message: "Service not found or unavailable.",
      });
    }

    const customer = await db.collection("user").findOne({
      email: req.user.email,
    });

    if (!customer) {
      return res.status(404).send({
        message: "Customer account not found.",
      });
    }

    const existingBooking = await db.collection("bookings").findOne({
      serviceId: service._id.toString(),
      customerEmail: req.user.email,
      status: {
        $in: ["requested", "accepted", "in-progress"],
      },
    });

    if (existingBooking) {
      return res.status(409).send({
        message: "You already have an active request for this service.",
      });
    }

    const booking = {
      serviceId: service._id.toString(),
      serviceTitle: service.title,
      serviceImage: service.image,
      category: service.category,
      basePrice: service.basePrice,

      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,

      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: phone.trim(),

      address: address.trim(),
      preferredDate,
      problemDescription: problemDescription.trim(),

      status: "requested",
      finalAmount: service.basePrice,
      paymentStatus: "unpaid",

      createdAt: new Date(),
    };

    const result = await db.collection("bookings").insertOne(booking);

    res.status(201).send({
      message: "Repair request submitted successfully.",
      booking: {
        ...booking,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    console.error("Booking creation error:", error);

    res.status(500).send({
      message: "Failed to create booking.",
    });
  }
});



app.listen(port, ()=>{
    console.log(`Listening to port ${port}...`);
});

export default app;