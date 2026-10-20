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

  function validateEnvironment() {
    for (const name of REQUIRED_ENV) {
      if (!process.env[name]) {
        throw new Error(`Missing environment variable: ${name}`);
      }
    }

    if (!/^[0-9a-fA-F]{64}$/.test(
      process.env.CLASSROOM_TOKEN_ENCRYPTION_KEY
    )) {
      throw new Error("Encryption key must be 64 hexadecimal characters.");
    }
  }

  function createOAuthClient() {
    validateEnvironment();

    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  function encryptTokens(tokens) {
    const key = Buffer.from(
      process.env.CLASSROOM_TOKEN_ENCRYPTION_KEY,
      "hex"
    );

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

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

  const scopes = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
    "https://www.googleapis.com/auth/classroom.announcements.readonly",
  ];

  // Start OAuth. Firebase authentication is required.
  router.get("/connect", requireFirebaseUser, async (req, res) => {
    try {
      validateEnvironment();

      const state = crypto.randomBytes(32).toString("hex");
      const stateHash = crypto
        .createHash("sha256")
        .update(state)
        .digest("hex");

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.execute(
        `DELETE FROM classroom_oauth_states WHERE expires_at < NOW()`
      );

      await pool.execute(
        `INSERT INTO classroom_oauth_states
         (state_hash, user_uid, expires_at)
         VALUES (?, ?, ?)`,
        [stateHash, req.firebaseUser.uid, expiresAt]
      );

      const oauth = createOAuthClient();

      const authorizationUrl = oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: scopes,
        state,
      });

      return res.json({ authorizationUrl });
    } catch (error) {
      console.error("Classroom connect error:", error.message);

      return res.status(500).json({
        error: "Unable to start Google Classroom connection.",
      });
    }
  });

  // Google redirects here without a Firebase bearer token.
  // The one-time state must identify the initiating Firebase user.
  router.get("/oauth2callback", async (req, res) => {
    let connectionStateConsumed = false;

    try {
      const { code, state, error: oauthError } = req.query;

      if (oauthError) {
        return res.status(400).send(
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
        return res.status(400).send(
          "OAuth session expired or invalid. Return to ClassConnect and reconnect."
        );
      }

      const userUid = rows[0].user_uid;

      // Consume the state before exchanging the code, preventing replay.
      const [deleted] = await pool.execute(
        `DELETE FROM classroom_oauth_states
         WHERE state_hash = ? AND expires_at > NOW()`,
        [stateHash]
      );

      if (deleted.affectedRows !== 1) {
        return res.status(400).send("OAuth state has already been used.");
      }

      connectionStateConsumed = true;

      const oauth = createOAuthClient();
      const { tokens } = await oauth.getToken(code);

      // Preserve a previously stored refresh token if Google omits
      // a new one during reconnection.
      const [existingRows] = await pool.execute(
        `SELECT encrypted_tokens FROM classroom_tokens
         WHERE user_uid = ? LIMIT 1`,
        [userUid]
      );

      let previousTokens = {};

      if (existingRows.length) {
        try {
          const saved = JSON.parse(existingRows[0].encrypted_tokens);
          const key = Buffer.from(
            process.env.CLASSROOM_TOKEN_ENCRYPTION_KEY,
            "hex"
          );
          const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            key,
            Buffer.from(saved.iv, "hex")
          );
          decipher.setAuthTag(Buffer.from(saved.tag, "hex"));

          previousTokens = JSON.parse(
            Buffer.concat([
              decipher.update(Buffer.from(saved.data, "hex")),
              decipher.final(),
            ]).toString("utf8")
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
        return res.status(400).send(
          "Google did not provide a refresh token. Disconnect the app from your Google Account permissions and try connecting again."
        );
      }

      await pool.execute(
        `INSERT INTO classroom_tokens (user_uid, encrypted_tokens)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE encrypted_tokens = VALUES(encrypted_tokens)`,
        [userUid, encryptTokens(mergedTokens)]
      );

      return res.redirect(
        "https://class-connect-server-mocha.vercel.app/?classroom=connected"
      );
    } catch (error) {
      console.error("Classroom OAuth callback failed:", error.message);

      return res.status(500).send(
        "Unable to finish Google Classroom connection. Return to ClassConnect and try again."
      );
    }
  });

  // Check whether the current Firebase user has connected Classroom.
  router.get("/status", requireFirebaseUser, async (req, res) => {
    try {
      const [rows] = await pool.execute(
        "SELECT id FROM classroom_tokens WHERE user_uid = ? LIMIT 1",
        [req.firebaseUser.uid]
      );

      return res.json({ connected: rows.length > 0 });
    } catch (error) {
      console.error("Classroom status error:", error.message);
      return res.status(500).json({ error: "Unable to check connection." });
    }
  });

  // Disconnect only the current Firebase user's Classroom account.
  router.delete("/disconnect", requireFirebaseUser, async (req, res) => {
    try {
      await pool.execute(
        "DELETE FROM classroom_tokens WHERE user_uid = ?",
        [req.firebaseUser.uid]
      );

      await pool.execute(
        "DELETE FROM classroom_oauth_states WHERE user_uid = ?",
        [req.firebaseUser.uid]
      );

      return res.json({ disconnected: true });
    } catch (error) {
      console.error("Classroom disconnect error:", error.message);
      return res.status(500).json({ error: "Unable to disconnect Classroom." });
    }
  });

  return router;
};