
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

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);

  if (className) element.className = className;

  element.textContent = text;
  return element;
}

function showEmptyState(title, message) {
  const empty = createElement("div", "empty-state");
  empty.append(
    createElement("div", "empty-state-icon", "✧"),
    createElement("h3", "", title),
    createElement("p", "", message)
  );

  assignmentList.replaceChildren(empty);
}

function updateStatistics() {
  const completed = assignments.filter(
    item => item.status === "Completed"
  ).length;

  totalCount.textContent = assignments.length;
  completedCount.textContent = completed;
  pendingCount.textContent = assignments.length - completed;
}

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
    year: "numeric"
  });
}

function getFilteredAssignments() {
  return assignments.filter(item => {
    const matchesStatus =
      activeFilter === "All" || item.status === activeFilter;

    const text = [
      item.title,
      item.subject,
      item.description || ""
    ].join(" ").toLowerCase();

    return matchesStatus && text.includes(searchTerm.toLowerCase());
  });
}

async function changeStatus(item, newStatus, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Updating...";

  try {
    // Endpoint must match the backend route.
    await apiRequest(`${API_URL}/${item.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus })
    });

    await loadAssignments();
  } catch (error) {
    console.error("Status update failed:", error);
    alert(
      "Status update nahi hua.\n" +
      error.message +
      "\n\nBackend API route check karna hoga."
    );

    button.disabled = false;
    button.textContent = originalText;
  }
}

async function deleteAssignment(item, button) {
  if (!confirm(`Delete "${item.title}"?`)) return;

  button.disabled = true;
  button.textContent = "Deleting...";

  try {
    await apiRequest(`${API_URL}/${item.id}`, {
      method: "DELETE"
    });

    await loadAssignments();
  } catch (error) {
    console.error("Delete failed:", error);
    alert("Assignment delete nahi hua: " + error.message);
    button.disabled = false;
    button.textContent = "Delete";
  }
}

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

  filtered.forEach(item => {
    const card = createElement("article", "assignment-item");
    const isCompleted = item.status === "Completed";

    if (isCompleted) card.classList.add("completed");

    card.append(
      createElement("h4", "", item.title),
      createElement("p", "", `Subject: ${item.subject}`)
    );

    if (item.description) {
      card.append(
        createElement("p", "", `Notes: ${item.description}`)
      );
    }

    card.append(
      createElement("p", "", `Due date: ${formatDeadline(item.deadline)}`),
      createElement("p", "", `Status: ${item.status}`)
    );

    const statusButton = createElement(
      "button",
      "",
      isCompleted ? "↶ Mark Pending" : "✓ Mark Complete"
    );

    statusButton.type = "button";

    statusButton.addEventListener("click", () => {
      changeStatus(
        item,
        isCompleted ? "Pending" : "Completed",
        statusButton
      );
    });

    const deleteButton = createElement("button", "", "Delete");
    deleteButton.type = "button";

    deleteButton.addEventListener("click", () => {
      deleteAssignment(item, deleteButton);
    });

    card.append(statusButton, deleteButton);
    assignmentList.appendChild(card);
  });
}

async function loadAssignments() {
  try {
    const data = await apiRequest(API_URL);

    if (!Array.isArray(data)) {
      throw new Error("Unexpected response from server.");
    }

    assignments = data;
    renderAssignments();
  } catch (error) {
    console.error("Loading assignments failed:", error);

    showEmptyState(
      "Couldn't load assignments",
      "Start the Node.js backend and check the MySQL connection. " +
      error.message
    );

    totalCount.textContent = "0";
    pendingCount.textContent = "0";
    completedCount.textContent = "0";
    visibleCount.textContent = "0 tasks";
  }
}

form.addEventListener("submit", async event => {
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
  addButton.textContent = "Saving...";

  try {
    await apiRequest(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        subject,
        description: description || null,
        deadline: deadline || null
      })
    });

    form.reset();

    activeFilter = "All";
    searchTerm = "";
    searchInput.value = "";

    filterButtons.forEach(button => {
      button.classList.toggle("active", button.dataset.filter === "All");
    });

    await loadAssignments();
  } catch (error) {
    console.error("Adding assignment failed:", error);
    alert("Assignment save nahi hua: " + error.message);
  } finally {
    isSaving = false;
    addButton.disabled = false;
    addButton.innerHTML = "<span>＋</span> Add assignment";
  }
});

searchInput.addEventListener("input", () => {
  searchTerm = searchInput.value.trim();
  renderAssignments();
});

filterButtons.forEach(button => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;

    filterButtons.forEach(filterButton => {
      filterButton.classList.toggle("active", filterButton === button);
    });

    renderAssignments();
  });
});

document.querySelectorAll(".nav-link").forEach(link => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach(item => {
      item.classList.toggle("active", item === link);
    });
  });
});

loadAssignments();

console.log("ClassConnect dashboard initialized.");
