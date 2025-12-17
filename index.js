require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

const app = express();

// ---- Firebase Admin -------
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ------ Middleware -------
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// -------- MongoDB Client ---------
const client = new MongoClient(process.env.MONGODB_URL, {
  serverApi: { version: ServerApiVersion.v1, strict: true },
});

// ------- JWT Middleware ------
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized" });
  }
};

// ------ Run Server -------
async function run() {
  try {
    const db = client.db("life-lessonsDB");
    const usersCollection = db.collection("users");
    const lessonCollection = db.collection("lessons");
    const contributorsCollection = db.collection("contributors");

    // ----- Admin Middleware -----
    const verifyAdmin = async (req, res, next) => {
      try {
        const user = await usersCollection.findOne({ email: req.tokenEmail });
        if (!user || user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden Access" });
        }
        next();
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    };

    // -------- Routes --------

    // Root
    app.get("/", (req, res) => res.send("Hello from Server.."));

    // ----- Lessons -----
    // Post a lesson
    app.post("/lessons", verifyJWT, async (req, res) => {
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

    // Get all lessons
    app.get("/lessons", async (req, res) => {
      let limit = parseInt(req.query.limit);
      const cursor = lessonCollection.find().sort({ _id: -1 });
      if (!isNaN(limit)) cursor.limit(limit);
      const lessons = await cursor.toArray();
      res.send(lessons);
    });

    // Get single lesson + author info
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const lesson = await lessonCollection.findOne({ _id: new ObjectId(id) });
      if (!lesson) return res.status(404).send({ message: "Lesson not found" });

      lesson.author = lesson.author || "Anonymous";
      lesson.authorAvatar = lesson.authorAvatar || "/images/default.jpg";
      lesson.authorLessonCount = await lessonCollection.countDocuments({
        author: lesson.author,
      });
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
    app.post("/lessons/:id/save", verifyJWT, async (req, res) => {
      const lessonId = req.params.id;
      const userEmail = req.tokenEmail;
      await lessonCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $inc: { saves: 1 } }
      );

      const user = await usersCollection.findOne({ email: userEmail });
      if (!user.savedLessons) user.savedLessons = [];

      if (!user.savedLessons.includes(lessonId)) {
        await usersCollection.updateOne(
          { email: userEmail },
          { $push: { savedLessons: lessonId } }
        );
      }

      res.send({ success: true });
    });

    // user save
    app.get("/users/:id/saved-lessons", async (req, res) => {
      const userId = req.params.id;

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) return res.status(404).send({ message: "User not found" });

      const savedLessonIds = user.savedLessons || [];

      const lessons = await lessonCollection
        .find({ _id: { $in: savedLessonIds.map((id) => new ObjectId(id)) } })
        .toArray();

      res.send(lessons);
    });

    // Share lesson
    app.post("/lessons/:id/share", async (req, res) => {
      const id = req.params.id;
      await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { shares: 1 } }
      );
      res.send({ success: true });
    });

    // Report lesson
    app.post("/lessons/:id/report", verifyJWT, async (req, res) => {
      const { reason } = req.body;
      const userEmail = req.tokenEmail;

      const newReport = {
        _id: new ObjectId(),
        user: userEmail,
        reason,
        createdAt: new Date(),
      };

      await lessonCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $inc: { report: 1 }, $push: { reports: newReport } }
      );
      res.send({ success: true });
    });

    // Add comment
    app.post(
      "/lessons/:id/comments/:commentId/replies",
      verifyJWT,
      async (req, res) => {
        const { text, name, avatar } = req.body;
        if (!text)
          return res.status(400).send({ message: "Reply text required" });

        const user = await usersCollection.findOne({ email: req.tokenEmail });

        const newReply = {
          _id: new ObjectId(),
          user: user.email,
          name: name || user.name || "Anonymous",
          avatar:
            user.photoURL ||
            avatar ||
            "https://i.pravatar.cc/30?u=" + user.email,
          text,
          createdAt: new Date(),
        };
        await lessonCollection.updateOne(
          {
            _id: new ObjectId(req.params.id),
            "comments._id": new ObjectId(req.params.commentId),
          },
          { $push: { "comments.$.replies": newReply } }
        );

        res.send(newReply);
      }
    );

    // Like comment
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

    // Add new comment
    app.post("/lessons/:id/comments", verifyJWT, async (req, res) => {
      const { text, avatar, name } = req.body;
      const lessonId = req.params.id;
      const user = await usersCollection.findOne({ email: req.tokenEmail });

      const newComment = {
        _id: new ObjectId(),
        user: user.email,
        name: name || user.name,
        avatar: avatar || user.photoURL || "https://i.pravatar.cc/30",
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

    // Update lesson
    app.put("/lessons/:id", async (req, res) => {
      const { id } = req.params;
      const { title, content, image } = req.body;

      const result = await lessonCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { title, content, image, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0)
        return res.status(404).send({ message: "Lesson not found" });
      res.send({ message: "Lesson updated successfully" });
    });

    // Delete lesson
    app.delete("/lessons/:id", async (req, res) => {
      const { id } = req.params;
      const result = await lessonCollection.deleteOne({
        _id: new ObjectId(id),
      });
      if (result.deletedCount === 0)
        return res.status(404).send({ message: "Lesson not found" });
      res.send({ message: "Lesson deleted successfully" });
    });

    // ----- Contributors -----
    app.get("/contributors", async (req, res) => {
      const lessons = await lessonCollection.find().toArray();
      const userMap = {};

      lessons.forEach((lesson) => {
        const author = lesson.author || "Anonymous";
        const avatar = lesson.authorAvatar || "/images/default.jpg";

        if (userMap[author]) userMap[author].lessons++;
        else userMap[author] = { id: author, name: author, avatar, lessons: 1 };
      });

      const contributors = Object.values(userMap)
        .sort((a, b) => b.lessons - a.lessons)
        .slice(0, 10);

      res.send(contributors);
    });

    app.post("/contributors", async (req, res) => {
      const contributor = req.body;
      contributor.name = contributor.name || "Anonymous";
      contributor.lessons = contributor.lessons || 0;
      contributor.avatar = contributor.avatar || "/images/default.jpg";
      contributor.createdAt = new Date();

      const result = await contributorsCollection.insertOne(contributor);
      res.send(result);
    });

    // ----- Users -----
    app.post("/users", verifyJWT, async (req, res) => {
      const { name, email } = req.body;
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) return res.send(existingUser);

      const newUser = { name, email, role: "user", createdAt: new Date() };
      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    app.get("/users/role", verifyJWT, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: user?.role || "user" });
    });

    app.get("/users", verifyJWT, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // Delete user Admin
    app.delete("/users/:userId", verifyJWT, verifyAdmin, async (req, res) => {
      const { userId } = req.params;
      const result = await usersCollection.deleteOne({
        _id: new ObjectId(userId),
      });
      if (result.deletedCount === 0)
        return res.status(404).send({ message: "User not found" });
      res.send({ message: "User deleted successfully" });
    });

    // Update role
    app.patch("/users/:id/update-role", async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );

      if (result.modifiedCount > 0)
        res.send({ success: true, message: "Role updated successfully!" });
      else
        res
          .status(400)
          .send({ success: false, message: "Failed to update role" });
    });

    // ----- Stripe Payment -----
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
        metadata: { lessonId: req.body.lessonId },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancelled/${req.body.lessonId}`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const { session_id } = req.query;
      if (!session_id)
        return res.status(400).send({ error: "Session ID missing" });

      const session = await stripe.checkout.sessions.retrieve(session_id);
      const transactionId = session.payment_intent;
      const trackingId = "TRK-" + Date.now();

      res.send({ transactionId, trackingId });
    });

    // Get similar lessons
    app.get("/lessons/:id/similar", async (req, res) => {
      try {
        const { id } = req.params;

        const currentLesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!currentLesson) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        const similarLessons = await lessonCollection
          .find({
            _id: { $ne: new ObjectId(id) },
            $or: [
              { category: currentLesson.category },
              { tone: currentLesson.tone },
            ],
          })
          .limit(4)
          .toArray();

        res.send(similarLessons);
      } catch (error) {
        res.status(500).send({ message: "Failed to load similar lessons" });
      }
    });
    // ------ MongoDB Test -------
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB Connected!");
  } finally {
    // Do not close client, keep server running
  }
}

run().catch(console.dir);

app.listen(port, () => console.log(`Server running on port ${port}`));
