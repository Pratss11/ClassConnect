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
  // SAVE TOKENS
  // =====================================================

  async function saveUserTokens(userUid, tokens) {
    await pool.execute(
      `INSERT INTO classroom_tokens
       (user_uid, encrypted_tokens)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
       encrypted_tokens = VALUES(encrypted_tokens)`,
      [userUid, encryptTokens(tokens)]
    );
  }

  // =====================================================
  // GET USER'S SAVED GOOGLE TOKENS
  // REFRESH EXPIRED ACCESS TOKENS
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

    let tokens = decryptTokens(rows[0].encrypted_tokens);

    oauth.setCredentials(tokens);

    // Persist credentials when the Google library refreshes them.
    oauth.on("tokens", async (newTokens) => {
      try {
        tokens = {
          ...tokens,
          ...newTokens,
          refresh_token:
            newTokens.refresh_token || tokens.refresh_token,
        };

        await saveUserTokens(userUid, tokens);
      } catch (error) {
        console.error(
          "Failed to save refreshed Classroom tokens:",
          error.message
        );
      }
    });

    // Refresh before making Classroom API requests if necessary.
    if (
      !tokens.access_token ||
      !tokens.expiry_date ||
      tokens.expiry_date <= Date.now() + 60_000
    ) {
      if (!tokens.refresh_token) {
        throw new Error(
          "Google refresh token is missing. Reconnect Google Classroom."
        );
      }

      try {
        const { credentials } = await oauth.refreshAccessToken();

        tokens = {
          ...tokens,
          ...credentials,
          refresh_token:
            credentials.refresh_token || tokens.refresh_token,
        };

        oauth.setCredentials(tokens);

        await saveUserTokens(userUid, tokens);
      } catch (error) {
        console.error(
          "Google Classroom token refresh failed:",
          error.response?.data || error.message
        );

        throw error;
      }
    }

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
  // PAGINATION HELPER
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
  // OPTIONAL RESOURCE HELPER
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
        error.response?.status || error.code || 0
      );

      console.error(
        `Classroom ${resourceName} error for course ${courseId}:`,
        status,
        error.response?.data || error.message
      );

      // These errors may indicate inaccessible optional resources.
      if (status === 403 || status === 404) {
        return [];
      }

      // Do not silently treat authentication failures as empty data.
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
          error.response?.data || error.message
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
            "Google Classroom authorization was denied. Return to ClassConnect and try again."
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

      // Preserve the old refresh token if Google doesn't issue a new one.
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
        } catch (error) {
          console.error(
            "Could not decrypt previous Classroom tokens:",
            error.message
          );
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
            "Google did not provide a refresh token. Reconnect with the correct Google account and permissions."
          );
      }

      await saveUserTokens(userUid, mergedTokens);

      return res.redirect(
        "https://class-connect-server-mocha.vercel.app/?classroom=connected"
      );
    } catch (error) {
      console.error(
        "Classroom OAuth callback failed:",
        error.response?.data || error.message
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

        // 1. Fetch active courses.
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

        // 2. Fetch resources for each course.
        for (const course of courses.slice(0, 50)) {
          const courseId = course.id;

          const [
            courseWorkItems,
            announcementItems,
            materialItems,
          ] = await Promise.all([
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
                    data: response.data.courseWorkMaterial || [],
                    nextPageToken: response.data.nextPageToken,
                  };
                })
            ),
          ]);

          // 3. Format assignments.
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

          // 4. Format announcements.
          for (const item of announcementItems) {
            announcements.push({
              ...item,
              courseId,
              courseName: course.name,
            });
          }

          // 5. Format study materials and attachments.
          for (const item of materialItems) {
            const links = [];

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

        // 6. Sort assignments by due date.
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

        // 7. Sort announcements by latest update.
        announcements.sort((a, b) =>
          String(
            b.updateTime || b.creationTime || ""
          ).localeCompare(
            String(a.updateTime || a.creationTime || "")
          )
        );

        // 8. Sort materials by latest update.
        materials.sort((a, b) =>
          String(
            b.updateTime || b.creationTime || ""
          ).localeCompare(
            String(a.updateTime || a.creationTime || "")
          )
        );

        // 9. Return all resources and totals.
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
          error.response?.data || error.message
        );

        if (status === 401) {
          return res.status(401).json({
            error:
              "Google Classroom authorization expired or was rejected. Reconnect Google Classroom.",
            reconnectRequired: true,
          });
        }

        if (status === 403) {
          return res.status(403).json({
            error:
              "Google denied access. Check Classroom API enablement, account access, and the permissions granted.",
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