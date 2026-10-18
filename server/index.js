
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "50kb" }));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "classconnect_app",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "classconnect",
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

// Home
app.get("/", (req, res) => {
  res.json({
    message: "ClassConnect backend is running!",
    class: "TE AIML",
  });
});

// Health check
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
    console.error("Health check error:", error.message);

    res.status(500).json({
      status: "ERROR",
      database: "disconnected",
    });
  } finally {
    connection?.release();
  }
});

// Get all assignments
app.get("/api/assignments", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, title, subject, description, deadline, status, created_at
       FROM assignments
       ORDER BY created_at DESC, id DESC`
    );

    res.json(rows);
  } catch (error) {
    console.error("Fetch error:", error.message);

    res.status(500).json({
      error: "Could not fetch assignments",
    });
  }
});

// Add assignment
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
        error: "Title and subject are required",
      });
    }

    const cleanTitle = title.trim();
    const cleanSubject = subject.trim();

    if (cleanTitle.length > 150 || cleanSubject.length > 100) {
      return res.status(400).json({
        error: "Title or subject is too long",
      });
    }

    const cleanDescription =
      typeof description === "string" ? description.trim() : null;

    if (cleanDescription && cleanDescription.length > 20000) {
      return res.status(400).json({
        error: "Description is too long",
      });
    }

    let cleanDeadline = null;

    if (deadline) {
      if (
        typeof deadline !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(deadline)
      ) {
        return res.status(400).json({
          error: "Deadline must use YYYY-MM-DD format",
        });
      }

      const parsedDate = new Date(`${deadline}T00:00:00Z`);

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== deadline
      ) {
        return res.status(400).json({
          error: "Invalid deadline date",
        });
      }

      cleanDeadline = deadline;
    }

    const [result] = await pool.execute(
      `INSERT INTO assignments
       (title, subject, description, deadline)
       VALUES (?, ?, ?, ?)`,
      [cleanTitle, cleanSubject, cleanDescription, cleanDeadline]
    );

    res.status(201).json({
      message: "Assignment created successfully",
      id: result.insertId,
    });
  } catch (error) {
    console.error("Create error:", error.message);

    res.status(500).json({
      error: "Could not create assignment",
    });
  }
});

// Update status to Pending or Completed
app.patch("/api/assignments/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid assignment ID",
      });
    }

    if (!["Pending", "Completed"].includes(status)) {
      return res.status(400).json({
        error: "Status must be Pending or Completed",
      });
    }

    const [result] = await pool.execute(
      "UPDATE assignments SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      const [rows] = await pool.execute(
        "SELECT id FROM assignments WHERE id = ?",
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Assignment not found",
        });
      }
    }

    res.json({
      message: `Assignment marked as ${status}`,
    });
  } catch (error) {
    console.error("Status update error:", error.message);

    res.status(500).json({
      error: "Could not update assignment status",
    });
  }
});

// Compatibility with the old Mark Complete API
app.patch("/api/assignments/:id/complete", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid assignment ID",
      });
    }

    const [result] = await pool.execute(
      "UPDATE assignments SET status = 'Completed' WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      const [rows] = await pool.execute(
        "SELECT id FROM assignments WHERE id = ?",
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: "Assignment not found",
        });
      }
    }

    res.json({
      message: "Assignment marked as completed",
    });
  } catch (error) {
    console.error("Complete error:", error.message);

    res.status(500).json({
      error: "Could not complete assignment",
    });
  }
});

// Delete assignment
app.delete("/api/assignments/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Invalid assignment ID",
      });
    }

    const [result] = await pool.execute(
      "DELETE FROM assignments WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: "Assignment not found",
      });
    }

    res.json({
      message: "Assignment deleted successfully",
    });
  } catch (error) {
    console.error("Delete error:", error.message);

    res.status(500).json({
      error: "Could not delete assignment",
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`ClassConnect running at http://localhost:${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
