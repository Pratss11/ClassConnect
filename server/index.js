require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const admin = require("firebase-admin");
const createClassroomOAuthRouter = require("./classroom-oauth");

// =====================================================
// 1. FIREBASE ADMIN INITIALIZATION
// =====================================================

const FIREBASE_PROJECT_ID = "classconnect-42a51";

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else {
    serviceAccount = require("./serviceAccountKey.json");
  }
} catch (error) {
  console.error("Failed to load Firebase service account:", error.message);
  throw error;
}

if (serviceAccount.project_id !== FIREBASE_PROJECT_ID) {
  throw new Error(
    `Firebase project mismatch. Expected ${FIREBASE_PROJECT_ID}.`
  );
}

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// =====================================================
// 2. EXPRESS APPLICATION
// =====================================================

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());

app.use(
  express.json({
    limit: "50kb",
  })
);

// =====================================================
// 3. MYSQL DATABASE CONNECTION
// =====================================================

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "classconnect_app",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "classconnect",
  port: Number(process.env.DB_PORT) || 3306,

  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
};

if (process.env.DB_HOST) {
  if (!process.env.DB_CA_CERT) {
    throw new Error(
      "DB_CA_CERT is required when using the remote MySQL database."
    );
  }

  dbConfig.ssl = {
    ca: process.env.DB_CA_CERT.replace(/\\n/g, "\n"),
    rejectUnauthorized: true,
  };
}

const pool = mysql.createPool(dbConfig);

// =====================================================
// 4. FIREBASE AUTHENTICATION MIDDLEWARE
// =====================================================

async function requireFirebaseUser(req, res, next) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Sign in required. Missing Firebase authentication token.",
    });
  }

  try {
    const decoded = await admin
      .auth()
      .verifyIdToken(match[1]);

    req.firebaseUser = decoded;

    return next();
  } catch (error) {
    console.warn(
      "Firebase token verification failed:",
      error.code || error.message
    );

    return res.status(401).json({
      error: "Invalid or expired login. Please sign in again.",
    });
  }
}

// =====================================================
// 5. HOME ROUTE
// =====================================================

app.get("/", (req, res) => {
  res.json({
    message: "ClassConnect backend is running!",
    class: "TE AIML",
  });
});

// =====================================================
// 6. DATABASE HEALTH CHECK
// =====================================================

app.get("/api/health", async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();

    await connection.ping();

    return res.json({
      status: "OK",
      database: "connected",
    });
  } catch (error) {
    console.error("Database health check failed:", error.message);

    return res.status(500).json({
      status: "ERROR",
      database: "disconnected",
    });
  } finally {
    connection?.release();
  }
});

// =====================================================
// 7. GOOGLE CLASSROOM ROUTER
// =====================================================

const classroomOAuthRouter = createClassroomOAuthRouter({
  pool,
  requireFirebaseUser,
});

app.use("/api/classroom", classroomOAuthRouter);

console.log("Google Classroom routes registered");

// =====================================================
// 8. ASSIGNMENT AUTHENTICATION
// =====================================================

app.use("/api/assignments", requireFirebaseUser);

// =====================================================
// 9. GET ALL ASSIGNMENTS
// GET /api/assignments
// =====================================================

app.get("/api/assignments", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
         id,
         title,
         subject,
         description,
         deadline,
         status,
         created_at
       FROM assignments
       WHERE user_uid = ?
       ORDER BY created_at DESC, id DESC`,
      [req.firebaseUser.uid]
    );

    return res.json(rows);
  } catch (error) {
    console.error("Fetch assignments error:", error.message);

    return res.status(500).json({
      error:
        "Could not fetch assignments. Check the database configuration and assignments table.",
    });
  }
});

// =====================================================
// 10. CREATE ASSIGNMENT
// POST /api/assignments
// =====================================================

app.post("/api/assignments", async (req, res) => {
  try {
    const {
      title,
      subject,
      description,
      deadline,
    } = req.body;

    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof subject !== "string" ||
      !subject.trim()
    ) {
      return res.status(400).json({
        error: "Assignment title and subject are required.",
      });
    }

    const cleanTitle = title.trim();
    const cleanSubject = subject.trim();

    if (
      cleanTitle.length > 150 ||
      cleanSubject.length > 100
    ) {
      return res.status(400).json({
        error: "Title or subject is too long.",
      });
    }

    const cleanDescription =
      typeof description === "string"
        ? description.trim()
        : null;

    if (
      cleanDescription &&
      cleanDescription.length > 20000
    ) {
      return res.status(400).json({
        error: "Assignment description is too long.",
      });
    }

    let cleanDeadline = null;

    if (deadline) {
      if (
        typeof deadline !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(deadline)
      ) {
        return res.status(400).json({
          error: "Deadline must use YYYY-MM-DD format.",
        });
      }

      const parsedDate = new Date(`${deadline}T00:00:00Z`);

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== deadline
      ) {
        return res.status(400).json({
          error: "Invalid deadline date.",
        });
      }

      cleanDeadline = deadline;
    }

    const [result] = await pool.execute(
      `INSERT INTO assignments
         (user_uid, title, subject, description, deadline)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.firebaseUser.uid,
        cleanTitle,
        cleanSubject,
        cleanDescription,
        cleanDeadline,
      ]
    );

    return res.status(201).json({
      message: "Assignment created successfully.",
      id: result.insertId,
    });
  } catch (error) {
    console.error("Create assignment error:", error.message);

    return res.status(500).json({
      error: "Could not create assignment.",
    });
  }
});

// =====================================================
// 11. UPDATE ASSIGNMENT STATUS
// PATCH /api/assignments/:id/status
// =====================================================

app.patch("/api/assignments/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid assignment ID.",
      });
    }

    if (!["Pending", "Completed"].includes(status)) {
      return res.status(400).json({
        error: "Status must be Pending or Completed.",
      });
    }

    const [result] = await pool.execute(
      `UPDATE assignments
       SET status = ?
       WHERE id = ? AND user_uid = ?`,
      [status, id, req.firebaseUser.uid]
    );

    if (result.affectedRows === 0) {
      const [rows] = await pool.execute(
        `SELECT id
         FROM assignments
         WHERE id = ? AND user_uid = ?`,
        [id, req.firebaseUser.uid]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Assignment not found.",
        });
      }
    }

    return res.json({
      message: `Assignment marked as ${status}.`,
    });
  } catch (error) {
    console.error("Update assignment status error:", error.message);

    return res.status(500).json({
      error: "Could not update assignment status.",
    });
  }
});

// =====================================================
// 12. LEGACY COMPLETION ROUTE
// PATCH /api/assignments/:id/complete
// =====================================================

app.patch("/api/assignments/:id/complete", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid assignment ID.",
      });
    }

    const [result] = await pool.execute(
      `UPDATE assignments
       SET status = 'Completed'
       WHERE id = ? AND user_uid = ?`,
      [id, req.firebaseUser.uid]
    );

    if (result.affectedRows === 0) {
      const [rows] = await pool.execute(
        `SELECT id
         FROM assignments
         WHERE id = ? AND user_uid = ?`,
        [id, req.firebaseUser.uid]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Assignment not found.",
        });
      }
    }

    return res.json({
      message: "Assignment marked as completed.",
    });
  } catch (error) {
    console.error("Complete assignment error:", error.message);

    return res.status(500).json({
      error: "Could not complete assignment.",
    });
  }
});

// =====================================================
// 13. DELETE ASSIGNMENT
// DELETE /api/assignments/:id
// =====================================================

app.delete("/api/assignments/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid assignment ID.",
      });
    }

    const [result] = await pool.execute(
      `DELETE FROM assignments
       WHERE id = ? AND user_uid = ?`,
      [id, req.firebaseUser.uid]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: "Assignment not found.",
      });
    }

    return res.json({
      message: "Assignment deleted successfully.",
    });
  } catch (error) {
    console.error("Delete assignment error:", error.message);

    return res.status(500).json({
      error: "Could not delete assignment.",
    });
  }
});

// =====================================================
// 14. START SERVER
// =====================================================

const server = app.listen(PORT, () => {
  console.log(`ClassConnect server running on port ${PORT}`);
});

// =====================================================
// 15. GRACEFUL SHUTDOWN
// =====================================================

async function shutdown() {
  console.log("Shutting down ClassConnect server...");

  server.close(async () => {
    try {
      await pool.end();
      console.log("Database connection pool closed.");
      process.exit(0);
    } catch (error) {
      console.error("Shutdown error:", error.message);
      process.exit(1);
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);