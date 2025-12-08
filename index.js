require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
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

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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

    // =========== start ============

    // Save a plant data in db
    app.post("/lessons", async (req, res) => {
      const lessonData = req.body;
      const result = await lessonCollection.insertOne(lessonData);
      res.send(result);
    });

    // get all plants from db
    app.get("/lessons", async (req, res) => {
      const result = await lessonCollection.find().sort({ _id: -1 }).toArray();
      res.send(result);
    });

    // get one plants from db
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const result = await lessonCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Add a comment
    app.post("/lessons/:id/comments", async (req, res) => {
      const lessonId = req.params.id;
      const { text } = req.body;
      const user = req.tokenEmail; // JWT থেকে current user

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

      const result = await lessonCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $push: { comments: newComment } }
      );

      res.send(newComment);
    });

    // Add a reply
    app.post("/lessons/:id/comments/:commentId/replies", async (req, res) => {
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

      const result = await lessonCollection.updateOne(
        { _id: new ObjectId(id), "comments._id": new ObjectId(commentId) },
        { $push: { "comments.$.replies": newReply } }
      );

      res.send(newReply);
    });

    // Like a comment
    app.post("/lessons/:id/comments/:commentId/like", async (req, res) => {
      const { id, commentId } = req.params;

      await lessonCollection.updateOne(
        { _id: new ObjectId(id), "comments._id": new ObjectId(commentId) },
        { $inc: { "comments.$.likes": 1 } }
      );

      res.send({ success: true });
    });

    // =========== end ============
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
