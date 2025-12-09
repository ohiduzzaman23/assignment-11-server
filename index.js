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
  },
});

async function run() {
  try {
    const db = client.db("life-lessonsDB");
    const lessonCollection = db.collection("lessons");

    // Root
    app.get("/", (req, res) => res.send("Hello from Server.."));

    // Create Lesson
    app.post("/lessons", async (req, res) => {
      const lessonData = req.body;
      lessonData.likes = 0;
      lessonData.views = 0;
      lessonData.saves = 0;
      lessonData.comments = [];
      lessonData.createdAt = new Date();

      const result = await lessonCollection.insertOne(lessonData);
      res.send(result);
    });

    app.get("/lessons", async (req, res) => {
      let limit = parseInt(req.query.limit);

      const cursor = lessonCollection.find().sort({ _id: -1 });

      if (!isNaN(limit)) {
        cursor.limit(limit);
      }

      const lessons = await cursor.toArray();
      res.send(lessons);
    });

    // Get Single Lesson
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const lesson = await lessonCollection.findOne({ _id: new ObjectId(id) });
      res.send(lesson);
    });

    // Most Saved Lessons
    app.get("/lessons-worth", async (req, res) => {
      try {
        const topSaved = await lessonCollection
          .find()
          .sort({ saves: -1 })
          .limit(5)
          .toArray();

        res.send(topSaved);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch lessons", error });
      }
    });

    const contributorsCollection = db.collection("contributors");
    // Get Contributors
    app.get("/contributors", async (req, res) => {
      const contributors = await contributorsCollection
        .find()
        .sort({ lessons: -1 }) // sort by highest lessons
        .toArray();

      res.send(contributors);
    });

    app.post("/contributors", async (req, res) => {
      const contributor = req.body;

      // Default structure
      contributor.name = contributor.name || "Anonymous";
      contributor.lessons = contributor.lessons || 0;
      contributor.avatar = contributor.avatar || "";
      contributor.createdAt = new Date();

      const result = await contributorsCollection.insertOne(contributor);
      res.send(result);
    });

    // Increase Views
    app.post("/lessons/:id/view", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { views: 1 } }
      );
      res.send({ success: true });
    });

    // Like Lesson
    app.post("/lessons/:id/like", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { likes: 1 } }
      );
      res.send({ success: true });
    });

    // Save Lesson
    app.post("/lessons/:id/save", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { saves: 1 } }
      );
      res.send({ success: true });
    });

    // Add Comment
    app.post("/lessons/:id/comments", async (req, res) => {
      const lessonId = req.params.id;
      const { text } = req.body;

      if (!text)
        return res.status(400).send({ message: "Comment text required" });

      const newComment = {
        _id: new ObjectId(),
        user: req.tokenEmail,
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

    // Add Reply
    app.post(
      "/lessons/:id/comments/:commentId/replies",
      verifyJWT,
      async (req, res) => {
        const { id, commentId } = req.params;
        const { text } = req.body;

        if (!text)
          return res.status(400).send({ message: "Reply text required" });

        const newReply = {
          _id: new ObjectId(),
          user: req.tokenEmail,
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

    // Share
    app.post("/lessons/:id/share", async (req, res) => {
      const id = req.params.id;

      try {
        await lessonCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { shares: 1 } }
        );

        res.send({ success: true, message: "Lesson shared!" });
      } catch (error) {
        res.status(500).send({ message: "Share failed!", error });
      }
    });

    // Like Comment
    app.post("/lessons/:id/comments/:commentId/like", async (req, res) => {
      const { id, commentId } = req.params;

      await lessonCollection.updateOne(
        { _id: new ObjectId(id), "comments._id": new ObjectId(commentId) },
        { $inc: { "comments.$.likes": 1 } }
      );

      res.send({ success: true });
    });

    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Connected!");
  } finally {
  }
}

run().catch(console.dir);

app.listen(port, () => console.log(`Server running on port ${port}`));
