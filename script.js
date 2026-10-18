
const API_URL = "http://localhost:3000/api/assignments";

const form = document.getElementById("assignment-form");
const titleInput = document.getElementById("assignment-title");
const subjectInput = document.getElementById("assignment-subject");
const descriptionInput = document.getElementById("assignment-description");
const deadlineInput = document.getElementById("assignment-deadline");

const assignmentList = document.getElementById("assignment-list");
const searchInput = document.getElementById("assignment-search");
const addButton = document.getElementById("add-assignment-button");

const totalCount = document.getElementById("total-count");
const pendingCount = document.getElementById("pending-count");
const completedCount = document.getElementById("completed-count");
const visibleCount = document.getElementById("visible-count");

const filterButtons = document.querySelectorAll(".filter-button");

let assignments = [];
let activeFilter = "All";
let searchTerm = "";
let isSaving = false;

// API helper
async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

// Safe HTML elements
function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  element.textContent = text;
  return element;
}

// Empty state
function showEmptyState(title, message) {
  const empty = createElement("div", "empty-state");
  const icon = createElement("div", "empty-state-icon", "✧");
  const heading = createElement("h3", "", title);
  const paragraph = createElement("p", "", message);

  empty.append(icon, heading, paragraph);
  assignmentList.replaceChildren(empty);
}

// Dashboard statistics
function updateStatistics() {
  const completed = assignments.filter(
    (item) => item.status === "Completed"
  ).length;

  const pending = assignments.length - completed;

  totalCount.textContent = assignments.length;
  pendingCount.textContent = pending;
  completedCount.textContent = completed;
}

// Format YYYY-MM-DD without timezone shifts
function formatDeadline(deadline) {
  if (!deadline) return "Not set";

  const value = String(deadline).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) return value;

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );

  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Search and filter
function getFilteredAssignments() {
  return assignments.filter((item) => {
    const matchesStatus =
      activeFilter === "All" || item.status === activeFilter;

    const searchableText = [
      item.title,
      item.subject,
      item.description || "",
    ]
      .join(" ")
      .toLowerCase();

    const matchesSearch = searchableText.includes(
      searchTerm.toLowerCase()
    );

    return matchesStatus && matchesSearch;
  });
}

// Render assignments
function renderAssignments() {
  updateStatistics();

  const filtered = getFilteredAssignments();

  visibleCount.textContent =
    `${filtered.length} ${filtered.length === 1 ? "task" : "tasks"}`;

  if (assignments.length === 0) {
    showEmptyState(
      "Your workspace is ready",
      "Add your first assignment using the form."
    );
    return;
  }

  if (filtered.length === 0) {
    showEmptyState(
      "No matching assignments",
      "Try another search or select a different filter."
    );
    return;
  }

  assignmentList.replaceChildren();

  filtered.forEach((item) => {
    const card = createElement("article", "assignment-item");
    const isCompleted = item.status === "Completed";

    if (isCompleted) {
      card.classList.add("completed");
    }

    const title = createElement("h4", "", item.title);
    const subject = createElement(
      "p",
      "",
      `Subject: ${item.subject}`
    );

    const deadline = createElement(
      "p",
      "",
      `Due date: ${formatDeadline(item.deadline)}`
    );

    const status = createElement(
      "p",
      "",
      `Status: ${item.status}`
    );

    card.append(title, subject);

    if (item.description) {
      card.append(
        createElement("p", "", `Notes: ${item.description}`)
      );
    }

    card.append(deadline, status);

    // Mark Complete / Mark Pending
    const statusButton = createElement(
      "button",
      "",
      isCompleted ? "↶ Mark Pending" : "✓ Mark Complete"
    );

    statusButton.type = "button";

    statusButton.addEventListener("click", async () => {
      statusButton.disabled = true;

      try {
        await apiRequest(`${API_URL}/${item.id}/status`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            status: isCompleted ? "Pending" : "Completed",
          }),
        });

        await loadAssignments();
      } catch (error) {
        console.error("Status update error:", error);
        alert(error.message || "Could not update assignment.");
        statusButton.disabled = false;
      }
    });

    // Delete assignment
    const deleteButton = createElement("button", "", "Delete");
    deleteButton.type = "button";

    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Delete "${item.title}"?`)) return;

      deleteButton.disabled = true;

      try {
        await apiRequest(`${API_URL}/${item.id}`, {
          method: "DELETE",
        });

        await loadAssignments();
      } catch (error) {
        console.error("Delete error:", error);
        alert(error.message || "Could not delete assignment.");
        deleteButton.disabled = false;
      }
    });

    card.append(statusButton, deleteButton);
    assignmentList.appendChild(card);
  });
}

// Load from MySQL through backend
async function loadAssignments() {
  showEmptyState(
    "Loading your workspace",
    "Fetching your assignments..."
  );

  try {
    const data = await apiRequest(API_URL);

    if (!Array.isArray(data)) {
      throw new Error("Unexpected response from server.");
    }

    assignments = data;
    renderAssignments();
  } catch (error) {
    console.error("Load error:", error);

    showEmptyState(
      "Couldn't load assignments",
      "Check that your backend and MySQL database are running."
    );
  }
}

// Add assignment
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isSaving) return;

  const title = titleInput.value.trim();
  const subject = subjectInput.value.trim();
  const description = descriptionInput.value.trim();
  const deadline = deadlineInput.value;

  if (!title || !subject) {
    alert("Please enter the assignment title and subject.");
    return;
  }

  isSaving = true;
  addButton.disabled = true;
  addButton.textContent = "Saving assignment...";

  try {
    await apiRequest(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        subject,
        description: description || null,
        deadline: deadline || null,
      }),
    });

    form.reset();

    activeFilter = "All";
    searchTerm = "";
    searchInput.value = "";

    filterButtons.forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.filter === "All"
      );
    });

    await loadAssignments();

    document.getElementById("assignment-section").scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  } catch (error) {
    console.error("Save error:", error);
    alert(error.message || "Could not save assignment.");
  } finally {
    isSaving = false;
    addButton.disabled = false;
    addButton.innerHTML = "<span>＋</span> Add assignment";
  }
});

// Search
searchInput.addEventListener("input", () => {
  searchTerm = searchInput.value.trim();
  renderAssignments();
});

// Filters
filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;

    filterButtons.forEach((filterButton) => {
      filterButton.classList.toggle(
        "active",
        filterButton === button
      );
    });

    renderAssignments();
  });
});

// Sidebar navigation active state
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => {
      item.classList.toggle("active", item === link);
    });
  });
});

// Placeholder for sections not implemented yet
function showMessage(message) {
  alert(message);
}

// Start application
loadAssignments();

console.log("ClassConnect dashboard initialized.");
