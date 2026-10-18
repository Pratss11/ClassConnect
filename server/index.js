
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

// Use Firebase Admin's modular API.
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json");

const EXPECTED_PROJECT_ID = "classconnect-42a51";

if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
  throw new Error(
    `Wrong Firebase project. Expected ${EXPECTED_PROJECT_ID}.`
  );
}

// Initialize Firebase Admin once.
if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const firebaseAuth = getAuth();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "50kb" }));

// MySQL connection.

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "classconnect_app",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "classconnect",
  port: Number(process.env.DB_PORT) || 3306,

  ssl: process.env.DB_HOST
  ? {
      ca: process.env.DB_CA_CERT
        ? process.env.DB_CA_CERT.replace(/\\n/g, "\n")
        : require("fs").readFileSync("./ca.pem", "utf8"),
      rejectUnauthorized: true,
    }
  : undefined,

  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});


// Home route.
app.get("/", (req, res) => {
  res.json({
    message: "ClassConnect backend is running!",
  });
});

// Database health check.
app.get("/api/health", async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.ping();

    res.json({
      status: "OK",
      database: "connected",
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(500).json({
      status: "ERROR",
      database: "disconnected",
    });
  } finally {
    connection?.release();
  }
});

// Verify Firebase ID tokens.
async function requireFirebaseUser(req, res, next) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Please sign in to manage assignments.",
    });
  }

  try {
    req.firebaseUser = await firebaseAuth.verifyIdToken(match[1]);
    return next();
  } catch (error) {
    console.error(
      "Firebase token verification failed:",
      error.code || error.message
    );

    return res.status(401).json({
      error: "Invalid or expired session. Please sign in again.",
    });
  }
}

// All assignment routes require Firebase authentication.
app.use("/api/assignments", requireFirebaseUser);

// GET: current user's assignments only.
app.get("/api/assignments", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, title, subject, description, deadline, status, created_at
       FROM assignments
       WHERE user_uid = ?
       ORDER BY created_at DESC, id DESC`,
      [req.firebaseUser.uid]
    );

    res.json(rows);
  } catch (error) {
    console.error("Fetch assignments failed:", error.message);

    res.status(500).json({
      error: "Could not load assignments. Check the database schema.",
    });
  }
});

// POST: create assignment for the signed-in user.
app.post("/api/assignments", async (req, res) => {
  try {
    const { title, subject, description, deadline } = req.body;

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
    const cleanDescription =
      typeof description === "string" ? description.trim() : "";

    if (cleanTitle.length > 150 || cleanSubject.length > 100) {
      return res.status(400).json({
        error: "Title or subject is too long.",
      });
    }

    if (cleanDescription.length > 20000) {
      return res.status(400).json({
        error: "Description is too long.",
      });
    }

    let cleanDeadline = null;

    if (deadline !== undefined && deadline !== null && deadline !== "") {
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
        cleanDescription || null,
        cleanDeadline,
      ]
    );

    res.status(201).json({
      message: "Assignment created successfully.",
      id: result.insertId,
    });
  } catch (error) {
    console.error("Create assignment failed:", error.message);

    res.status(500).json({
      error: "Could not save the assignment.",
    });
  }
});

// PATCH: update status only for the assignment owner.
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
        `SELECT id FROM assignments
         WHERE id = ? AND user_uid = ?`,
        [id, req.firebaseUser.uid]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Assignment not found.",
        });
      }
    }

    res.json({
      message: `Assignment marked as ${status}.`,
    });
  } catch (error) {
    console.error("Update status failed:", error.message);

    res.status(500).json({
      error: "Could not update assignment status.",
    });
  }
});

// Compatibility endpoint for older frontend code.
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
        `SELECT id FROM assignments
         WHERE id = ? AND user_uid = ?`,
        [id, req.firebaseUser.uid]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Assignment not found.",
        });
      }
    }

    res.json({
      message: "Assignment marked as completed.",
    });
  } catch (error) {
    console.error("Complete assignment failed:", error.message);

    res.status(500).json({
      error: "Could not complete assignment.",
    });
  }
});

// DELETE: only the owner can delete their assignment.
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

    res.json({
      message: "Assignment deleted successfully.",
    });
  } catch (error) {
    console.error("Delete assignment failed:", error.message);

    res.status(500).json({
      error: "Could not delete assignment.",
    });
  }
});

// Start the backend.
let server;

if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`ClassConnect running at http://localhost:${PORT}`);
  });
}

module.exports = { app, pool, firebaseAuth };

async function shutdown() {
  if (!server) {
    await pool.end();
    return;
  }

  server.close(async () => {
    try {
      await pool.end();
    } catch (error) {
      console.error("MySQL shutdown error:", error.message);
    }

    process.exit(0);
  });
}

if (require.main === module) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}