
const firebaseConfig = {
  apiKey: "AIzaSyANyFw8l3efaykZf3q8AaTW8yctOoezIzo",
  authDomain: "classconnect-42a51.firebaseapp.com",
  projectId: "classconnect-42a51",
  storageBucket: "classconnect-42a51.firebasestorage.app",
  messagingSenderId: "899645718197",
  appId: "1:899645718197:web:425e1dbcc178f5b94e08fc",
  measurementId: "G-DGLZ9GPQ4Z"
};

if (typeof firebase === "undefined") {
  document.body.innerHTML =
    "<p style='color:red;padding:20px'>Firebase SDK failed to load. Check your internet connection.</p>";
  throw new Error("Firebase SDK is unavailable.");
}

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();

let authMode = "login";

document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  const authSection = $("auth-section");
  const appShell = $("app-shell");
  const form = $("auth-form");
  const emailInput = $("auth-email");
  const passwordInput = $("auth-password");
  const loginButton = $("login-button");
  const signupButton = $("signup-button");
  const forgotButton = $("forgot-password");
  const logoutButton = $("logout-button");
  const heading = $("auth-heading");
  const subtitle = $("auth-subtitle");
  const message = $("auth-message");
  const studentEmail = $("student-email");

  if (!authSection || !appShell || !form || !emailInput ||
      !passwordInput || !loginButton || !signupButton ||
      !forgotButton || !message) {
    console.error("Required HTML elements are missing.");
    return;
  }

  function showMessage(text, success = false) {
    message.textContent = text;
    message.style.color = success ? "#4ade80" : "#f87171";
  }

  function setMode(mode) {
    authMode = mode;

    heading.textContent =
      mode === "signup" ? "Create your account" : "Welcome back";

    subtitle.textContent =
      mode === "signup"
        ? "Create your ClassConnect student account."
        : "Sign in to continue to ClassConnect.";

    loginButton.textContent =
      mode === "signup" ? "Create account" : "Sign in";

    signupButton.textContent =
      mode === "signup"
        ? "Back to sign in"
        : "Create a student account";

    passwordInput.autocomplete =
      mode === "signup" ? "new-password" : "current-password";

    showMessage("");
  }

  // Switch to signup mode.
  signupButton.addEventListener("click", (event) => {
    event.preventDefault();
    setMode(authMode === "login" ? "signup" : "login");
  });

  // Create an account or log in.
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showMessage("Enter your email and password.");
      return;
    }

    if (password.length < 6) {
      showMessage("Password must be at least 6 characters.");
      return;
    }

    loginButton.disabled = true;
    signupButton.disabled = true;
    forgotButton.disabled = true;
    loginButton.textContent =
      authMode === "signup" ? "Creating account..." : "Signing in...";

    try {
      if (authMode === "signup") {
        const result = await auth.createUserWithEmailAndPassword(email, password);

        showMessage("Account created successfully!", true);

        // Profile is optional; a Firestore error won't undo signup.
        try {
          await db.collection("users").doc(result.user.uid).set({
            email: result.user.email,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        } catch (profileError) {
          console.error("Firestore profile error:", profileError);
          showMessage(
            "Account created, but profile saving failed. Check Firestore rules.",
            false
          );
        }
      } else {
        await auth.signInWithEmailAndPassword(email, password);
        showMessage("Login successful!", true);
      }
    } catch (error) {
      console.error("Authentication error:", error);

      const errors = {
        "auth/email-already-in-use": "This email is already registered. Sign in instead.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/weak-password": "Choose a stronger password.",
        "auth/user-not-found": "Account not found. Create an account first.",
        "auth/wrong-password": "Incorrect email or password.",
        "auth/invalid-credential": "Incorrect email or password.",
        "auth/operation-not-allowed": "Enable Email/Password in Firebase Authentication.",
        "auth/network-request-failed": "Network error. Check your connection.",
        "auth/too-many-requests": "Too many attempts. Try again later."
      };

      showMessage(errors[error.code] || error.message);
    } finally {
      loginButton.disabled = false;
      signupButton.disabled = false;
      forgotButton.disabled = false;
      setMode(authMode);
    }
  });

  // Send password reset email.
  forgotButton.addEventListener("click", async () => {
    const email = emailInput.value.trim();

    if (!email) {
      showMessage("Enter your email address first.");
      emailInput.focus();
      return;
    }

    forgotButton.disabled = true;

    try {
      await auth.sendPasswordResetEmail(email);
      showMessage("Password reset email sent. Check inbox and spam.", true);
    } catch (error) {
      console.error("Password reset error:", error);

      const errors = {
        "auth/invalid-email": "Enter a valid email address.",
        "auth/user-not-found": "No account found for this email.",
        "auth/too-many-requests": "Too many attempts. Try again later."
      };

      showMessage(errors[error.code] || error.message);
    } finally {
      forgotButton.disabled = false;
    }
  });

  // Show dashboard only after authentication.
  auth.onAuthStateChanged((user) => {
    if (user) {
      authSection.hidden = true;
      appShell.hidden = false;
      if (studentEmail) studentEmail.textContent = user.email || "";
    } else {
      authSection.hidden = false;
      appShell.hidden = true;
      if (studentEmail) studentEmail.textContent = "";
    }
  });

  // Log out.
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      try {
        await auth.signOut();
        passwordInput.value = "";
        setMode("login");
        showMessage("Logged out successfully.", true);
      } catch (error) {
        console.error("Logout error:", error);
        showMessage("Unable to log out. Please try again.");
      }
    });
  }

  setMode("login");
  console.log("ClassConnect Firebase initialized successfully.");
});
