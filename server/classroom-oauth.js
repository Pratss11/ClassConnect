const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");

module.exports = function createClassroomOAuthRouter({
  pool,
  requireFirebaseUser,
}) {
  const router = express.Router();

  // =====================================================
  // ENVIRONMENT CONFIGURATION
  // =====================================================

  function validateEnvironment() {
    const required = [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "CLASSROOM_TOKEN_ENCRYPTION_KEY",
    ];

    for (const name of required) {
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
        "CLASSROOM_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters."
      );
    }
  }

  // =====================================================
  // GOOGLE OAUTH CLIENT
  // =====================================================

  function createOAuthClient() {
    validateEnvironment();

    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  // =====================================================
  // ENCRYPTION AND DECRYPTION
  // =====================================================

  function getEncryptionKey() {
    return Buffer.from(
      process.env.CLASSROOM_TOKEN_ENCRYPTION_KEY,
      "hex"
    );
  }

  function encryptTokens(tokens) {
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
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

  function decryptTokens(value) {
    const saved =
      typeof value === "string" ? JSON.parse(value) : value;

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(saved.iv, "hex")
    );

    decipher.setAuthTag(Buffer.from(saved.tag, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(saved.data, "hex")),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  }

  // =====================================================
  // GET USER'S SAVED GOOGLE TOKENS
  // =====================================================

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

    // Save refreshed tokens without exposing them to the browser.
    oauth.on("tokens", async (newTokens) => {
      try {
        const updatedTokens = {
          ...tokens,
          ...newTokens,
          refresh_token:
            newTokens.refresh_token || tokens.refresh_token,
        };

        await pool.execute(
          `UPDATE classroom_tokens
           SET encrypted_tokens = ?
           WHERE user_uid = ?`,
          [encryptTokens(updatedTokens), userUid]
        );

        Object.assign(tokens, updatedTokens);
      } catch (error) {
        console.error(
          "Failed to save refreshed Classroom tokens:",
          error.message
        );
      }
    });

    return oauth;
  }

  // =====================================================
  // GOOGLE CLASSROOM PERMISSIONS
  // =====================================================

  const scopes = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
  ];

  // =====================================================
  // HELPER: FETCH PAGINATED RESULTS
  // =====================================================

  async function listAll(fetchPage) {
    const results = [];
    let pageToken;

    do {
      const page = await fetchPage(pageToken);

      results.push(...(page.data || []));
      pageToken = page.nextPageToken;
    } while (pageToken && results.length < 500);

    return results;
  }

  // =====================================================
  // HELPER: HANDLE OPTIONAL COURSE RESOURCES
  // =====================================================

  async function fetchOptionalResources(
    resourceName,
    courseId,
    fetchFunction
  ) {
    try {
      return await fetchFunction();
    } catch (error) {
      const status = Number(
        error.code || error.response?.status || 0
      );

      console.error(
        `Classroom ${resourceName} error for course ${courseId}:`,
        status,
        error.message
      );

      // Continue loading other resources if one resource is forbidden.
      if (status === 403 || status === 404) {
        return [];
      }

      throw error;
    }
  }

  // =====================================================
  // CONNECT GOOGLE CLASSROOM
  // GET /api/classroom/connect
  // =====================================================

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

        const expiresAt = new Date(
          Date.now() + 10 * 60 * 1000
        );

        await pool.execute(
          "DELETE FROM classroom_oauth_states WHERE expires_at < NOW()"
        );

        await pool.execute(
          `INSERT INTO classroom_oauth_states
           (state_hash, user_uid, expires_at)
           VALUES (?, ?, ?)`,
          [stateHash, req.firebaseUser.uid, expiresAt]
        );

        const authorizationUrl =
          createOAuthClient().generateAuthUrl({
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

  // =====================================================
  // GOOGLE OAUTH CALLBACK
  // GET /api/classroom/oauth2callback
  // =====================================================

  router.get("/oauth2callback", async (req, res) => {
    try {
      const {
        code,
        state,
        error: oauthError,
      } = req.query;

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
         WHERE state_hash = ?
           AND expires_at > NOW()
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
         WHERE state_hash = ?
           AND expires_at > NOW()`,
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
            "Google did not provide a refresh token. Check your Google account permissions and reconnect."
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
          "Unable to finish Google Classroom connection. Check Render logs."
        );
    }
  });

  // =====================================================
  // CHECK CONNECTION STATUS
  // GET /api/classroom/status
  // =====================================================

  router.get(
    "/status",
    requireFirebaseUser,
    async (req, res) => {
      try {
        const [rows] = await pool.execute(
          `SELECT user_uid
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
          error: "Unable to check Classroom connection.",
        });
      }
    }
  );

  // =====================================================
  // FETCH ALL CLASSROOM DATA
  // GET /api/classroom/data
  //
  // Returns:
  // courses
  // coursework
  // announcements
  // materials
  // =====================================================

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

        // -------------------------------------------------
        // 1. FETCH COURSES
        // -------------------------------------------------

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
        const materials = [];

        // -------------------------------------------------
        // 2. FETCH EACH COURSE'S RESOURCES
        // -------------------------------------------------

        for (const course of courses.slice(0, 50)) {
          const courseId = course.id;

          // Fetch assignments, announcements and materials.
          const [courseWorkItems, announcementItems, materialItems] =
            await Promise.all([
              fetchOptionalResources(
                "coursework",
                courseId,
                () =>
                  listAll(async (pageToken) => {
                    const response =
                      await classroom.courses.courseWork.list({
                        courseId,
                        pageSize: 100,
                        pageToken,
                        orderBy: "dueDate asc",
                      });

                    return {
                      data: response.data.courseWork || [],
                      nextPageToken: response.data.nextPageToken,
                    };
                  })
              ),

              fetchOptionalResources(
                "announcements",
                courseId,
                () =>
                  listAll(async (pageToken) => {
                    const response =
                      await classroom.courses.announcements.list({
                        courseId,
                        pageSize: 100,
                        pageToken,
                        orderBy: "updateTime desc",
                      });

                    return {
                      data: response.data.announcements || [],
                      nextPageToken: response.data.nextPageToken,
                    };
                  })
              ),

              fetchOptionalResources(
                "materials",
                courseId,
                () =>
                  listAll(async (pageToken) => {
                    const response =
                      await classroom.courses.courseWorkMaterials.list({
                        courseId,
                        pageSize: 100,
                        pageToken,
                        orderBy: "updateTime desc",
                      });

                    return {
                      data:
                        response.data.courseWorkMaterial || [],
                      nextPageToken: response.data.nextPageToken,
                    };
                  })
              ),
            ]);

          // -------------------------------------------------
          // 3. FORMAT ASSIGNMENTS
          // -------------------------------------------------

          for (const item of courseWorkItems) {
            const dueDateText = item.dueDate
              ? [
                  item.dueDate.year,
                  String(item.dueDate.month).padStart(2, "0"),
                  String(item.dueDate.day).padStart(2, "0"),
                ].join("-")
              : null;

            coursework.push({
              ...item,
              courseId,
              courseName: course.name,
              dueDateText,
            });
          }

          // -------------------------------------------------
          // 4. FORMAT ANNOUNCEMENTS
          // -------------------------------------------------

          for (const item of announcementItems) {
            announcements.push({
              ...item,
              courseId,
              courseName: course.name,
            });
          }

          // -------------------------------------------------
          // 5. FORMAT STUDY MATERIALS AND PDF LINKS
          // -------------------------------------------------

          for (const item of materialItems) {
            const links = [];

            // Links and files attached to a material.
            for (const attachment of item.materials || []) {
              if (attachment.driveFile?.driveFile) {
                const file = attachment.driveFile.driveFile;

                links.push({
                  type: "driveFile",
                  title: file.title || "Google Drive file",
                  url: file.alternateLink || null,
                  driveFileId: file.id || null,
                  mimeType: file.mimeType || null,
                });
              }

              if (attachment.link?.url) {
                links.push({
                  type: "link",
                  title:
                    attachment.link.title || attachment.link.url,
                  url: attachment.link.url,
                });
              }

              if (attachment.youtubeVideo?.alternateLink) {
                links.push({
                  type: "youtube",
                  title:
                    attachment.youtubeVideo.title || "YouTube video",
                  url: attachment.youtubeVideo.alternateLink,
                });
              }

              if (attachment.form?.formUrl) {
                links.push({
                  type: "form",
                  title:
                    attachment.form.title || "Google Form",
                  url: attachment.form.formUrl,
                });
              }
            }

            materials.push({
              ...item,
              courseId,
              courseName: course.name,
              links,
            });
          }
        }

        // -------------------------------------------------
        // 6. SORT ASSIGNMENTS BY DUE DATE
        // -------------------------------------------------

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

        // -------------------------------------------------
        // 7. SORT ANNOUNCEMENTS BY RECENT UPDATE
        // -------------------------------------------------

        announcements.sort((a, b) =>
          String(b.updateTime || b.creationTime || "").localeCompare(
            String(a.updateTime || a.creationTime || "")
          )
        );

        // -------------------------------------------------
        // 8. SORT MATERIALS BY RECENT UPDATE
        // -------------------------------------------------

        materials.sort((a, b) =>
          String(b.updateTime || b.creationTime || "").localeCompare(
            String(a.updateTime || a.creationTime || "")
          )
        );

        // -------------------------------------------------
        // 9. RETURN COMPLETE DATA
        // -------------------------------------------------

        return res.json({
          success: true,
          courses,
          coursework,
          announcements,
          materials,
          totals: {
            courses: courses.length,
            coursework: coursework.length,
            announcements: announcements.length,
            materials: materials.length,
          },
        });
      } catch (error) {
        const status = Number(
          error.response?.status || error.code || 500
        );

        console.error(
          "Classroom data fetch failed:",
          status,
          error.message
        );

        if (status === 401 || status === 403) {
          return res.status(status).json({
            error:
              "Google denied access to Classroom data. Check the granted permissions and Google Classroom API settings.",
          });
        }

        return res.status(500).json({
          error:
            "Unable to load Google Classroom data. Check Render logs.",
        });
      }
    }
  );

  // =====================================================
  // DISCONNECT GOOGLE CLASSROOM
  // DELETE /api/classroom/disconnect
  // =====================================================

  router.delete(
    "/disconnect",
    requireFirebaseUser,
    async (req, res) => {
      try {
        await pool.execute(
          `DELETE FROM classroom_tokens
           WHERE user_uid = ?`,
          [req.firebaseUser.uid]
        );

        await pool.execute(
          `DELETE FROM classroom_oauth_states
           WHERE user_uid = ?`,
          [req.firebaseUser.uid]
        );

        return res.json({
          success: true,
          disconnected: true,
        });
      } catch (error) {
        console.error(
          "Classroom disconnect error:",
          error.message
        );

        return res.status(500).json({
          error: "Unable to disconnect Google Classroom.",
        });
      }
    }
  );

  return router;
};