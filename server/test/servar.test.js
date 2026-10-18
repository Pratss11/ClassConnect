
jest.mock("firebase-admin/app", () => ({
  initializeApp: jest.fn(),
  cert: jest.fn(() => ({})),
  getApps: jest.fn(() => [{}]),
}));

jest.mock("firebase-admin/auth", () => ({
  getAuth: jest.fn(() => ({
    verifyIdToken: jest.fn(),
  })),
}));

jest.mock("../serviceAccountKey.json", () => ({
  project_id: "classconnect-42a51",
}));

jest.mock("mysql2/promise", () => ({
  createPool: jest.fn(() => ({
    getConnection: jest.fn(),
    execute: jest.fn(),
    end: jest.fn(),
  })),
}));

const request = require("supertest");
const { app, pool } = require("../index");

describe("ClassConnect backend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("Home route returns running message", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(
      "ClassConnect backend is running!"
    );
  });

  test("Assignments route rejects missing authentication", async () => {
    const response = await request(app).get("/api/assignments");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe(
      "Please sign in to manage assignments."
    );
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test("Health route succeeds when database connects", async () => {
    const connection = {
      ping: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    };

    pool.getConnection.mockResolvedValue(connection);

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "OK",
      database: "connected",
    });
    expect(connection.release).toHaveBeenCalled();
  });

  test("Health route returns error when database fails", async () => {
    pool.getConnection.mockRejectedValue(
      new Error("Database unavailable")
    );

    const response = await request(app).get("/api/health");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      status: "ERROR",
      database: "disconnected",
    });
  });
});
