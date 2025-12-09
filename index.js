require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

// Firebase Admin Initialization
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// JWT Middleware
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// MongoDB Client
const client = new MongoClient(process.env.MONGODB_URL, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("life-lessonsDB");
    const lessonCollection = db.collection("lessons");

    // ================= ROUTES =================

    // Ping
    app.get("/", (req, res) => {
      res.send("Hello from Server..");
    });

    // CREATE a lesson
    app.post("/lessons", async (req, res) => {
      const lessonData = req.body;
      const result = await lessonCollection.insertOne(lessonData);
      res.send(result);
    });

    // GET lessons (all or limited)
    app.get("/lessons", async (req, res) => {
      try {
        const limit = parseInt(req.query.limit); // optional
        let cursor = lessonCollection.find().sort({ _id: -1 });
        if (limit) cursor = cursor.limit(limit);
        const lessons = await cursor.toArray();
        res.send(lessons);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // GET single lesson by id
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const lesson = await lessonCollection.findOne({ _id: new ObjectId(id) });
      res.send(lesson);
    });

    // ================= COMMENTS =================

    // Add a comment
    app.post("/lessons/:id/comments", verifyJWT, async (req, res) => {
      const lessonId = req.params.id;
      const { text } = req.body;
      const user = req.tokenEmail;

      if (!text)
        return res.status(400).send({ message: "Comment text required" });

      const newComment = {
        _id: new ObjectId(),
        user,
        text,
        likes: 0,
        replies: [],
        createdAt: new Date(),
      };

      await lessonCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $push: { comments: newComment } }
      );

      res.send(newComment);
    });

    // Add a reply to a comment
    app.post(
      "/lessons/:id/comments/:commentId/replies",
      verifyJWT,
      async (req, res) => {
        const { id, commentId } = req.params;
        const { text } = req.body;
        const user = req.tokenEmail;

        if (!text)
          return res.status(400).send({ message: "Reply text required" });

        const newReply = {
          _id: new ObjectId(),
          user,
          text,
          createdAt: new Date(),
        };

        await lessonCollection.updateOne(
          { _id: new ObjectId(id), "comments._id": new ObjectId(commentId) },
          { $push: { "comments.$.replies": newReply } }
        );

        res.send(newReply);
      }
    );

    // Like a comment
    app.post(
      "/lessons/:id/comments/:commentId/like",
      verifyJWT,
      async (req, res) => {
        const { id, commentId } = req.params;

        await lessonCollection.updateOne(
          { _id: new ObjectId(id), "comments._id": new ObjectId(commentId) },
          { $inc: { "comments.$.likes": 1 } }
        );

        res.send({ success: true });
      }
    );

    // Ping to check DB
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB connected successfully!");
  } finally {
    // client close handled by server shutdown
  }
}

run().catch(console.dir);

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
