const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");

module.exports = function createClassroomOAuthRouter({
  pool,
  requireFirebaseUser,
}) {
  const router = express.Router();

  const REQUIRED_ENV = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "CLASSROOM_TOKEN_ENCRYPTION_KEY",
  ];

  // Validate required environment variables
  function validateEnvironment() {
    for (const name of REQUIRED_ENV) {
      if (!process.env[name]) {
        throw new Error(`Missing environment variable: ${name}`);
      }
    }

    if (
      !/^[0-9a-fA-F]{64}$/.test(
        process.env.CLASSROOM_TOKEN_ENCRYPTION_KEY
      )
    ) {
      throw new Error(
        "CLASSROOM_TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters."
      );
    }
  }

  // Create Google OAuth client
  function createOAuthClient() {
    validateEnvironment();

    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  // Encryption key
  function encryptionKey() {
    return Buffer.from(
      process.env.CLASSROOM_TOKEN_ENCRYPTION_KEY,
      "hex"
    );
  }

  // Encrypt Google OAuth tokens before saving them
  function encryptTokens(tokens) {
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      encryptionKey(),
      iv
    );

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
    ]);

    return JSON.stringify({
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: encrypted.toString("hex"),
    });
  }

  // Decrypt stored Google OAuth tokens
  function decryptTokens(value) {
    const saved =
      typeof value === "string" ? JSON.parse(value) : value;

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(saved.iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(saved.tag, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(saved.data, "hex")),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  }

  // Get the connected user's Google OAuth client
  async function getUserOAuthClient(userUid) {
    const [rows] = await pool.execute(
      `SELECT encrypted_tokens
       FROM classroom_tokens
       WHERE user_uid = ?
       LIMIT 1`,
      [userUid]
    );

    if (!rows.length) {
      return null;
    }

    const oauth = createOAuthClient();
    const tokens = decryptTokens(rows[0].encrypted_tokens);

    oauth.setCredentials(tokens);

    // Save refreshed tokens securely
    oauth.on("tokens", async (newTokens) => {
      try {
        const mergedTokens = {
          ...tokens,
          ...newTokens,
          refresh_token:
            newTokens.refresh_token || tokens.refresh_token,
        };

        await pool.execute(
          `UPDATE classroom_tokens
           SET encrypted_tokens = ?
           WHERE user_uid = ?`,
          [encryptTokens(mergedTokens), userUid]
        );

        Object.assign(tokens, mergedTokens);
      } catch (error) {
        console.error(
          "Saving refreshed Classroom tokens failed:",
          error.message
        );
      }
    });

    return oauth;
  }

  // Fetch all pages from a Google Classroom API endpoint
  async function listAll(fetchPage) {
    const all = [];
    let pageToken;

    do {
      const result = await fetchPage(pageToken);

      all.push(...(result.data || []));

      pageToken = result.nextPageToken;
    } while (pageToken && all.length < 500);

    return all;
  }

  // Google Classroom permissions
  const scopes = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
  ];

  // =========================================================
  // CONNECT GOOGLE CLASSROOM
  // GET /api/classroom/connect
  // =========================================================

  router.get(
    "/connect",
    requireFirebaseUser,
    async (req, res) => {
      try {
        validateEnvironment();

        const state = crypto.randomBytes(32).toString("hex");

        const stateHash = crypto
          .createHash("sha256")
          .update(state)
          .digest("hex");

        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await pool.execute(
          "DELETE FROM classroom_oauth_states WHERE expires_at < NOW()"
        );

        await pool.execute(
          `INSERT INTO classroom_oauth_states
           (state_hash, user_uid, expires_at)
           VALUES (?, ?, ?)`,
          [stateHash, req.firebaseUser.uid, expiresAt]
        );

        const authorizationUrl = createOAuthClient().generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: scopes,
          state,
        });

        return res.json({ authorizationUrl });
      } catch (error) {
        console.error(
          "Classroom connect error:",
          error.message
        );

        return res.status(500).json({
          error: "Unable to start Google Classroom connection.",
        });
      }
    }
  );

  // =========================================================
  // GOOGLE OAUTH CALLBACK
  // GET /api/classroom/oauth2callback
  // =========================================================

  router.get("/oauth2callback", async (req, res) => {
    try {
      const { code, state, error: oauthError } = req.query;

      if (oauthError) {
        return res
          .status(400)
          .send(
            "Google Classroom connection was cancelled or denied. Return to ClassConnect and try again."
          );
      }

      if (
        typeof code !== "string" ||
        typeof state !== "string" ||
        !/^[0-9a-f]{64}$/.test(state)
      ) {
        return res.status(400).send("Invalid OAuth callback.");
      }

      const stateHash = crypto
        .createHash("sha256")
        .update(state)
        .digest("hex");

      const [rows] = await pool.execute(
        `SELECT user_uid
         FROM classroom_oauth_states
         WHERE state_hash = ? AND expires_at > NOW()
         LIMIT 1`,
        [stateHash]
      );

      if (rows.length !== 1) {
        return res
          .status(400)
          .send(
            "OAuth session expired or invalid. Return to ClassConnect and reconnect."
          );
      }

      const userUid = rows[0].user_uid;

      const [deleted] = await pool.execute(
        `DELETE FROM classroom_oauth_states
         WHERE state_hash = ? AND expires_at > NOW()`,
        [stateHash]
      );

      if (deleted.affectedRows !== 1) {
        return res
          .status(400)
          .send("OAuth state has already been used.");
      }

      const oauth = createOAuthClient();
      const { tokens } = await oauth.getToken(code);

      const [existingRows] = await pool.execute(
        `SELECT encrypted_tokens
         FROM classroom_tokens
         WHERE user_uid = ?
         LIMIT 1`,
        [userUid]
      );

      let previousTokens = {};

      if (existingRows.length) {
        try {
          previousTokens = decryptTokens(
            existingRows[0].encrypted_tokens
          );
        } catch {
          previousTokens = {};
        }
      }

      const mergedTokens = {
        ...previousTokens,
        ...tokens,
        refresh_token:
          tokens.refresh_token || previousTokens.refresh_token,
      };

      if (!mergedTokens.refresh_token) {
        return res
          .status(400)
          .send(
            "Google did not provide a refresh token. Remove ClassConnect from your Google Account permissions and reconnect."
          );
      }

      await pool.execute(
        `INSERT INTO classroom_tokens
         (user_uid, encrypted_tokens)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
         encrypted_tokens = VALUES(encrypted_tokens)`,
        [userUid, encryptTokens(mergedTokens)]
      );

      return res.redirect(
        "https://class-connect-server-mocha.vercel.app/?classroom=connected"
      );
    } catch (error) {
      console.error(
        "Classroom OAuth callback failed:",
        error.message
      );

      return res
        .status(500)
        .send(
          "Unable to finish Google Classroom connection. Return to ClassConnect and try again."
        );
    }
  });

  // =========================================================
  // CHECK CONNECTION STATUS
  // GET /api/classroom/status
  // =========================================================

  router.get(
    "/status",
    requireFirebaseUser,
    async (req, res) => {
      try {
        const [rows] = await pool.execute(
          `SELECT id
           FROM classroom_tokens
           WHERE user_uid = ?
           LIMIT 1`,
          [req.firebaseUser.uid]
        );

        return res.json({
          connected: rows.length > 0,
        });
      } catch (error) {
        console.error(
          "Classroom status error:",
          error.message
        );

        return res.status(500).json({
          error: "Unable to check connection.",
        });
      }
    }
  );

  // =========================================================
  // FETCH COURSES, ASSIGNMENTS AND ANNOUNCEMENTS
  // GET /api/classroom/data
  // =========================================================

  router.get(
    "/data",
    requireFirebaseUser,
    async (req, res) => {
      try {
        const oauth = await getUserOAuthClient(
          req.firebaseUser.uid
        );

        if (!oauth) {
          return res.status(409).json({
            error:
              "Google Classroom is not connected. Connect your account first.",
          });
        }

        const classroom = google.classroom({
          version: "v1",
          auth: oauth,
        });

        // Fetch active courses
        const courses = await listAll(async (pageToken) => {
          const response = await classroom.courses.list({
            pageSize: 100,
            pageToken,
            courseStates: ["ACTIVE"],
          });

          return {
            data: response.data.courses || [],
            nextPageToken: response.data.nextPageToken,
          };
        });

        const coursework = [];
        const announcements = [];

        // Fetch assignments and announcements for each course
        for (const course of courses.slice(0, 50)) {
          const [workItems, noticeItems] = await Promise.all([
            listAll(async (pageToken) => {
              const response =
                await classroom.courses.courseWork.list({
                  courseId: course.id,
                  pageSize: 100,
                  pageToken,
                  orderBy: "dueDate asc",
                });

              return {
                data: response.data.courseWork || [],
                nextPageToken: response.data.nextPageToken,
              };
            }).catch((error) => {
              const status =
                error.code || error.response?.status;

              if ([403, 404].includes(Number(status))) {
                console.warn(
                  `Cannot read coursework for course ${course.id}:`,
                  error.message
                );

                return [];
              }

              throw error;
            }),

            listAll(async (pageToken) => {
              const response =
                await classroom.courses.announcements.list({
                  courseId: course.id,
                  pageSize: 100,
                  pageToken,
                  orderBy: "updateTime desc",
                });

              return {
                data: response.data.announcements || [],
                nextPageToken: response.data.nextPageToken,
              };
            }).catch((error) => {
              const status =
                error.code || error.response?.status;

              if ([403, 404].includes(Number(status))) {
                console.warn(
                  `Cannot read announcements for course ${course.id}:`,
                  error.message
                );

                return [];
              }

              throw error;
            }),
          ]);

          for (const item of workItems) {
            const dueDateText = item.dueDate
              ? `${item.dueDate.year}-${String(
                  item.dueDate.month
                ).padStart(2, "0")}-${String(
                  item.dueDate.day
                ).padStart(2, "0")}`
              : "";

            coursework.push({
              ...item,
              courseName: course.name,
              courseId: course.id,
              dueDateText,
            });
          }

          for (const item of noticeItems) {
            announcements.push({
              ...item,
              courseName: course.name,
              courseId: course.id,
            });
          }
        }

        // Sort assignments by due date
        coursework.sort((a, b) => {
          const dateA = a.dueDate
            ? Date.UTC(
                a.dueDate.year,
                (a.dueDate.month || 1) - 1,
                a.dueDate.day || 1
              )
            : Number.MAX_SAFE_INTEGER;

          const dateB = b.dueDate
            ? Date.UTC(
                b.dueDate.year,
                (b.dueDate.month || 1) - 1,
                b.dueDate.day || 1
              )
            : Number.MAX_SAFE_INTEGER;

          return dateA - dateB;
        });

        // Sort announcements by latest update
        announcements.sort((a, b) =>
          String(b.updateTime || b.creationTime || "").localeCompare(
            String(a.updateTime || a.creationTime || "")
          )
        );

        return res.json({
          courses,
          coursework,
          announcements,
        });
      } catch (error) {
        const status = error.response?.status || 500;

        console.error(
          "Classroom data fetch failed:",
          status,
          error.message
        );

        if (status === 401 || status === 403) {
          return res.status(status).json({
            error:
              "Google denied access to Classroom data. Reconnect Google Classroom and confirm the requested permissions.",
          });
        }

        if (status === 404) {
          return res.status(404).json({
            error:
              "Classroom resource was not found. Check course access and API settings.",
          });
        }

        return res.status(500).json({
          error:
            "Unable to load Google Classroom data. Check Render logs for the detailed API error.",
        });
      }
    }
  );

  // =========================================================
  // DISCONNECT GOOGLE CLASSROOM
  // DELETE /api/classroom/disconnect
  // =========================================================

  router.delete(
    "/disconnect",
    requireFirebaseUser,
    async (req, res) => {
      try {
        await pool.execute(
          "DELETE FROM classroom_tokens WHERE user_uid = ?",
          [req.firebaseUser.uid]
        );

        await pool.execute(
          "DELETE FROM classroom_oauth_states WHERE user_uid = ?",
          [req.firebaseUser.uid]
        );

        return res.json({
          disconnected: true,
        });
      } catch (error) {
        console.error(
          "Classroom disconnect error:",
          error.message
        );

        return res.status(500).json({
          error: "Unable to disconnect Classroom.",
        });
      }
    }
  );

  return router;
};