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

    const technician = await db.collection("user").findOne(
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

app.get("/api/bookings/my", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const bookings = await db
      .collection("bookings")
      .find({ customerEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(bookings);
  } catch (error) {
    console.error("My bookings fetch error:", error);
    res.status(500).send({ message: "Failed to fetch bookings." });
  }
});

app.patch(
  "/api/bookings/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid booking ID." });
      }

      const result = await db.collection("bookings").updateOne(
        {
          _id: new ObjectId(id),
          customerEmail: req.user.email,
          status: "requested",
        },
        {
          $set: {
            status: "cancelled",
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          message: "Booking not found or can no longer be cancelled.",
        });
      }

      res.send({ message: "Booking cancelled successfully." });
    } catch (error) {
      console.error("Booking cancellation error:", error);
      res.status(500).send({ message: "Failed to cancel booking." });
    }
  }
);

app.get(
  "/api/technician/services",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const services = await db
        .collection("services")
        .find({ technicianEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(services);
    } catch (error) {
      console.error("Technician services error:", error);
      res.status(500).send({
        message: "Failed to fetch your services.",
      });
    }
  }
);

app.get(
  "/api/technician/bookings",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const bookings = await db
        .collection("bookings")
        .find({ technicianEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(bookings);
    } catch (error) {
      console.error("Technician bookings error:", error);
      res.status(500).send({
        message: "Failed to fetch your bookings.",
      });
    }
  }
);

app.post(
  "/api/services",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const {
        title,
        description,
        category,
        basePrice,
        image,
        serviceMode,
        estimatedDuration,
        serviceArea,
      } = req.body;

      if (
        !title ||
        !description ||
        !category ||
        !basePrice ||
        !serviceMode ||
        !estimatedDuration ||
        !serviceArea
      ) {
        return res.status(400).send({
          message: "Please provide all required fields.",
        });
      }

      // Retrieve the authenticated technician's information
      const technician = await db.collection("user").findOne({
        email: req.user.email,
      });

      if (!technician) {
        return res.status(404).send({
          message: "Technician account not found.",
        });
      }

      const newService = {
        title,
        description,
        category,
        basePrice: Number(basePrice),
        image: image || "",
        serviceMode,
        estimatedDuration,
        serviceArea,

        // Automatically populated from the technician's account
        technicianName: technician.name,
        technicianEmail: technician.email,

        approvalStatus: "pending",
        isAvailable: true,
        createdAt: new Date(),
      };

      const result = await db.collection("services").insertOne(newService);

      res.status(201).send({
        message: "Service submitted successfully. Awaiting admin approval.",
        insertedId: result.insertedId,
      });
    } catch (error) {
      console.error("Add service error:", error);

      res.status(500).send({
        message: "Failed to add service.",
      });
    }
  }
);

app.patch(
  "/api/services/:id",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid service ID." });
      }

      const service = await db.collection("services").findOne({
        _id: new ObjectId(id),
        technicianEmail: req.user.email,
      });

      if (!service) {
        return res.status(404).send({ message: "Service not found." });
      }

      if (
        Object.keys(req.body).length === 1 &&
        typeof req.body.isAvailable === "boolean"
      ) {
        await db.collection("services").updateOne(
          { _id: new ObjectId(id), technicianEmail: req.user.email },
          { $set: { isAvailable: req.body.isAvailable } }
        );

        return res.send({ message: "Availability updated successfully." });
      }

      const {
        title,
        description,
        category,
        basePrice,
        image,
        estimatedDuration,
        serviceMode,
        serviceArea,
      } = req.body;

      if (
        !title?.trim() ||
        !description?.trim() ||
        !category ||
        !Number.isFinite(Number(basePrice)) ||
        Number(basePrice) <= 0 ||
        !estimatedDuration ||
        !serviceMode ||
        !serviceArea?.trim() ||
        !image
      ) {
        return res.status(400).send({
          message: "Please provide all required service information.",
        });
      }

      await db.collection("services").updateOne(
        { _id: new ObjectId(id), technicianEmail: req.user.email },
        {
          $set: {
            title: title.trim(),
            description: description.trim(),
            category,
            basePrice: Number(basePrice),
            image,
            estimatedDuration,
            serviceMode,
            serviceArea: serviceArea.trim(),
            approvalStatus: "pending",
          },
        }
      );

      res.send({ message: "Service updated. Awaiting admin approval." });
    } catch (error) {
      console.error("Service update error:", error);
      res.status(500).send({ message: "Failed to update service." });
    }
  }
);


app.delete(
  "/api/services/:id",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid service ID." });
      }

      const result = await db.collection("services").deleteOne({
        _id: new ObjectId(id),
        technicianEmail: req.user.email,
      });

      if (result.deletedCount === 0) {
        return res.status(404).send({ message: "Service not found." });
      }

      res.send({ message: "Service deleted successfully." });
    } catch (error) {
      console.error("Service deletion error:", error);
      res.status(500).send({ message: "Failed to delete service." });
    }
  }
);



app.patch(
  "/api/bookings/:id/status",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, finalAmount } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid booking ID." });
      }

      const booking = await db.collection("bookings").findOne({
        _id: new ObjectId(id),
        technicianEmail: req.user.email,
      });

      if (!booking) {
        return res.status(404).send({ message: "Booking not found." });
      }

      const allowedTransitions = {
        requested: ["accepted", "rejected"],
        accepted: ["in-progress"],
        "in-progress": ["completed"],
      };

      if (!allowedTransitions[booking.status]?.includes(status)) {
        return res.status(400).send({
          message: "Invalid booking status transition.",
        });
      }

      const updateData = {
        status,
        updatedAt: new Date(),
      };

      if (status === "completed") {
        if (!Number.isFinite(Number(finalAmount)) || Number(finalAmount) <= 0) {
          return res.status(400).send({
            message: "Please provide a valid final amount.",
          });
        }

        updateData.finalAmount = Number(finalAmount);
      }

      await db.collection("bookings").updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData }
      );

      res.send({ message: `Booking ${status} successfully.` });
    } catch (error) {
      console.error("Booking status update error:", error);

      res.status(500).send({
        message: "Failed to update booking status.",
      });
    }
  }
);


app.get("/api/admin/services", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const services = await db.collection("services")
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(services);
  } catch (error) {
    res.status(500).send({
      message: "Failed to load services.",
    });
  }
});

app.patch("/api/admin/services/:id/approval", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).send({
        message: "Invalid approval status.",
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID.",
      });
    }

    const result = await db.collection("services").updateOne(
      {
        _id: new ObjectId(id),
        approvalStatus: "pending",
      },
      {
        $set: {
          approvalStatus: status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Pending service not found.",
      });
    }

    res.send({
      message: `Service ${status} successfully.`,
    });
  } catch (error) {
    res.status(500).send({
      message: "Failed to update service approval.",
    });
  }
});


app.listen(port, ()=>{
    console.log(`Listening to port ${port}...`);
});


export default app;