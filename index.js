require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;

// Firebase Admin
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

// JWT Verify Middleware
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!" });
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
    const contributorsCollection = db.collection("contributors");

    // Root route
    app.get("/", (req, res) => res.send("Hello from Server.."));

    // Post lessons
    app.post("/lessons", async (req, res) => {
      const lessonData = req.body;

      lessonData.likes = 0;
      lessonData.views = 0;
      lessonData.saves = 0;
      lessonData.comments = [];
      lessonData.shares = 0;
      lessonData.createdAt = new Date();

      lessonData.author = lessonData.author || "Anonymous";
      lessonData.authorAvatar =
        lessonData.authorAvatar || "/images/default.jpg";

      const result = await lessonCollection.insertOne(lessonData);

      // Update contributors
      if (lessonData.author) {
        await contributorsCollection.updateOne(
          { name: lessonData.author },
          {
            $setOnInsert: {
              name: lessonData.author,
              avatar: lessonData.authorAvatar,
              createdAt: new Date(),
            },
            $inc: { lessons: 1 },
          },
          { upsert: true }
        );
      }

      res.send(result);
    });

    // Get All Lessons
    app.get("/lessons", async (req, res) => {
      let limit = parseInt(req.query.limit);
      const cursor = lessonCollection.find().sort({ _id: -1 });
      if (!isNaN(limit)) cursor.limit(limit);

      const lessons = await cursor.toArray();
      res.send(lessons);
    });

    //payment related apis
    app.post("/create-checkout-session", async (req, res) => {
      const FIXED_BDT_PRICE = 1500;
      const USD_RATE = 127;

      const amount = Math.round((FIXED_BDT_PRICE / USD_RATE) * 100);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: req.body.lessonTitle || "Premium Lesson Access",
                description: "Price ৳1500 BDT (charged in USD)",
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: req.body.senderEmail,
        metadata: {
          lessonId: req.body.lessonId,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancelled/${req.body.lessonId}`,
      });

      res.send({ url: session.url });
    });

    // Get Single Lesson + Author's
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;

      // Fetch the lesson
      const lesson = await lessonCollection.findOne({ _id: new ObjectId(id) });
      if (!lesson) return res.status(404).send({ message: "Lesson not found" });

      lesson.author = lesson.author || "Anonymous";
      lesson.authorAvatar = lesson.authorAvatar || "/images/default.jpg";

      const authorLessonCount = await lessonCollection.countDocuments({
        author: lesson.author,
      });
      lesson.authorLessonCount = authorLessonCount;

      lesson.authorId = lesson.author;

      res.send(lesson);
    });

    // Get top saved lessons
    app.get("/lessons-worth", async (req, res) => {
      try {
        const topSaved = await lessonCollection
          .find()
          .sort({ saves: -1 })
          .limit(5)
          .toArray();

        const lessonsWithAuthor = topSaved.map((lesson) => ({
          ...lesson,
          author: lesson.author || "Anonymous",
          authorAvatar: lesson.authorAvatar || "/images/default.jpg",
        }));

        res.send(lessonsWithAuthor);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch lessons", error });
      }
    });

    // Get Contributors
    app.get("/contributors", async (req, res) => {
      try {
        const lessons = await lessonCollection.find().toArray();

        const userMap = {};

        lessons.forEach((lesson) => {
          const author = lesson.author || "Anonymous";
          const avatar = lesson.authorAvatar || "/images/default.jpg";

          if (userMap[author]) {
            userMap[author].lessons++;
          } else {
            userMap[author] = {
              id: author,
              name: author,
              avatar: avatar,
              lessons: 1,
            };
          }
        });

        const contributors = Object.values(userMap)
          .sort((a, b) => b.lessons - a.lessons)
          .slice(0, 10);

        res.send(contributors);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });
    // Add Contributor
    app.post("/contributors", async (req, res) => {
      const contributor = req.body;
      contributor.name = contributor.name || "Anonymous";
      contributor.lessons = contributor.lessons || 0;
      contributor.avatar = contributor.avatar || "/images/default.jpg";
      contributor.createdAt = new Date();

      const result = await contributorsCollection.insertOne(contributor);
      res.send(result);
    });

    // Increment views
    app.post("/lessons/:id/view", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { views: 1 } }
      );
      res.send({ success: true });
    });

    // Like lesson
    app.post("/lessons/:id/like", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { likes: 1 } }
      );
      res.send({ success: true });
    });

    // Save lesson
    app.post("/lessons/:id/save", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { saves: 1 } }
      );
      res.send({ success: true });
    });

    // Add comment
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

    // Add reply
    app.post(
      "/lessons/:id/comments/:commentId/replies",

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

    // Share counter
    app.post("/lessons/:id/share", async (req, res) => {
      const id = req.params.id;
      try {
        await lessonCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { shares: 1 } }
        );
        res.send({ success: true });
      } catch (error) {
        res.status(500).send({ message: "Share failed!", error });
      }
    });

    // Like comment
    app.post("/lessons/:id/comments/:commentId/like", async (req, res) => {
      const { id, commentId } = req.params;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id), "comments._id": new ObjectId(commentId) },
        { $inc: { "comments.$.likes": 1 } }
      );
      res.send({ success: true });
    });

    //--------- Dashboard -------------
    // Update Lesson
    app.put("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const { title, content, image } = req.body;

      try {
        const result = await lessonCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              title,
              content,
              image,
              updatedAt: new Date(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        res.send({ message: "Lesson updated successfully" });
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .send({ message: "Failed to update lesson", error: err });
      }
    });

    // Delete Lesson
    app.delete("/lessons/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const result = await lessonCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        res.send({ message: "Lesson deleted successfully" });
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .send({ message: "Failed to delete lesson", error: err });
      }
    });

    //---------end----------

    // MongoDB Connection Test
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Connected!");
  } finally {
    // Do not close client, keep server running
  }
}

run().catch(console.dir);

app.listen(port, () => console.log(`Server running on port ${port}`));
