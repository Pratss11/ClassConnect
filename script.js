// ======================================================
// CLASSCONNECT - MAIN JAVASCRIPT
// Assignments, Search, Filters, Statistics and AI Assistant
// ======================================================

// ======================================================
// CONFIGURATION
// ======================================================

const API_URL = "https://classconnect-uw4e.onrender.com/api/assignments";

// Local AI backend for development.
// Change to the deployed backend URL when testing on Vercel.
const AI_API_URL = "http://localhost:3000/api/ai/chat";

// ======================================================
// ASSIGNMENT ELEMENTS
// ======================================================

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

// ======================================================
// API HELPER
// ======================================================

async function apiRequest(url, options = {}) {
    const response = await fetch(url, options);

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            data.error || `Request failed (${response.status})`
        );
    }

    return data;
}

// ======================================================
// DOM HELPER
// ======================================================

function createElement(tag, className = "", text = "") {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    element.textContent = text;

    return element;
}

// ======================================================
// EMPTY STATE
// ======================================================

function showEmptyState(title, message) {
    if (!assignmentList) return;

    const empty = createElement("div", "empty-state");

    empty.append(
        createElement("div", "empty-state-icon", "✧"),
        createElement("h3", "", title),
        createElement("p", "", message)
    );

    assignmentList.replaceChildren(empty);
}

// ======================================================
// STATISTICS
// ======================================================

function updateStatistics() {
    const completed = assignments.filter(
        item => item.status === "Completed"
    ).length;

    if (totalCount) {
        totalCount.textContent = assignments.length;
    }

    if (completedCount) {
        completedCount.textContent = completed;
    }

    if (pendingCount) {
        pendingCount.textContent = assignments.length - completed;
    }
}

// ======================================================
// FORMAT DEADLINE
// ======================================================

function formatDeadline(deadline) {
    if (!deadline) {
        return "Not set";
    }

    const value = String(deadline).slice(0, 10);

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

    if (!match) {
        return value;
    }

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

// ======================================================
// FILTER ASSIGNMENTS
// ======================================================

function getFilteredAssignments() {
    return assignments.filter(item => {
        const matchesStatus =
            activeFilter === "All" ||
            item.status === activeFilter;

        const text = [
            item.title,
            item.subject,
            item.description || ""
        ].join(" ").toLowerCase();

        return (
            matchesStatus &&
            text.includes(searchTerm.toLowerCase())
        );
    });
}

// ======================================================
// CHANGE ASSIGNMENT STATUS
// ======================================================

async function changeStatus(item, newStatus, button) {
    button.disabled = true;

    const originalText = button.textContent;

    button.textContent = "Updating...";

    try {
        await apiRequest(`${API_URL}/${item.id}/status`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                status: newStatus
            })
        });

        await loadAssignments();

    } catch (error) {
        console.error("Status update failed:", error);

        alert(
            "Status update nahi hua.\n" +
            error.message
        );

        button.disabled = false;
        button.textContent = originalText;
    }
}

// ======================================================
// DELETE ASSIGNMENT
// ======================================================

async function deleteAssignment(item, button) {
    if (!confirm(`Delete "${item.title}"?`)) {
        return;
    }

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

// ======================================================
// RENDER ASSIGNMENTS
// ======================================================

function renderAssignments() {
    updateStatistics();

    if (!assignmentList) {
        return;
    }

    const filtered = getFilteredAssignments();

    if (visibleCount) {
        visibleCount.textContent =
            `${filtered.length} ${filtered.length === 1 ? "task" : "tasks"}`;
    }

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

        if (isCompleted) {
            card.classList.add("completed");
        }

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
            createElement(
                "p",
                "",
                `Due date: ${formatDeadline(item.deadline)}`
            ),
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

        const deleteButton = createElement(
            "button",
            "",
            "Delete"
        );

        deleteButton.type = "button";

        deleteButton.addEventListener("click", () => {
            deleteAssignment(item, deleteButton);
        });

        card.append(statusButton, deleteButton);

        assignmentList.appendChild(card);
    });
}

// ======================================================
// LOAD ASSIGNMENTS
// ======================================================

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
            "Check the backend and database connection. " +
            error.message
        );

        if (totalCount) totalCount.textContent = "0";
        if (pendingCount) pendingCount.textContent = "0";
        if (completedCount) completedCount.textContent = "0";
        if (visibleCount) visibleCount.textContent = "0 tasks";
    }
}

// ======================================================
// ASSIGNMENT FORM
// ======================================================

if (form) {
    form.addEventListener("submit", async event => {
        event.preventDefault();

        if (isSaving) return;

        const title = titleInput?.value.trim() || "";
        const subject = subjectInput?.value.trim() || "";
        const description = descriptionInput?.value.trim() || "";
        const deadline = deadlineInput?.value || "";

        if (!title || !subject) {
            alert("Please enter the assignment title and subject.");
            return;
        }

        isSaving = true;

        if (addButton) {
            addButton.disabled = true;
            addButton.textContent = "Saving...";
        }

        try {
            await apiRequest(API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
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

            if (searchInput) {
                searchInput.value = "";
            }

            filterButtons.forEach(button => {
                button.classList.toggle(
                    "active",
                    button.dataset.filter === "All"
                );
            });

            await loadAssignments();

        } catch (error) {
            console.error("Adding assignment failed:", error);

            alert("Assignment save nahi hua: " + error.message);

        } finally {
            isSaving = false;

            if (addButton) {
                addButton.disabled = false;
                addButton.innerHTML = "<span>＋</span> Add assignment";
            }
        }
    });
}

// ======================================================
// ASSIGNMENT SEARCH
// ======================================================

if (searchInput) {
    searchInput.addEventListener("input", () => {
        searchTerm = searchInput.value.trim();

        renderAssignments();
    });
}

// ======================================================
// ASSIGNMENT FILTERS
// ======================================================

filterButtons.forEach(button => {
    button.addEventListener("click", () => {
        activeFilter = button.dataset.filter;

        filterButtons.forEach(filterButton => {
            filterButton.classList.toggle(
                "active",
                filterButton === button
            );
        });

        renderAssignments();
    });
});

// ======================================================
// NAVIGATION ACTIVE STATE
// ======================================================

document.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", () => {
        document.querySelectorAll(".nav-link").forEach(item => {
            item.classList.toggle("active", item === link);
        });
    });
});

// ======================================================
// CLASSCONNECT AI STUDY ASSISTANT
// ======================================================

function initializeClassConnectAI() {
    const aiForm = document.getElementById("ai-chat-form");
    const aiInput = document.getElementById("ai-chat-input");
    const aiMessages = document.getElementById("ai-chat-messages");
    const aiSendButton = document.getElementById("ai-send-button");

    if (!aiForm || !aiInput || !aiMessages || !aiSendButton) {
        console.warn("AI Assistant HTML elements not found.");
        return;
    }

    // Avoid duplicate listeners.
    if (aiForm.dataset.initialized === "true") {
        return;
    }

    aiForm.dataset.initialized = "true";

    function addAIMessage(text, sender) {
        const element = document.createElement("div");

        element.className = `ai-message ${sender}`;
        element.textContent = text;

        aiMessages.appendChild(element);
        aiMessages.scrollTop = aiMessages.scrollHeight;

        return element;
    }

    aiForm.addEventListener("submit", async event => {
        // This prevents the normal form submission and page refresh.
        event.preventDefault();

        const message = aiInput.value.trim();

        if (!message) {
            return;
        }

        if (message.length > 4000) {
            addAIMessage(
                "Please keep your question under 4000 characters.",
                "error"
            );

            return;
        }

        if (!window.firebase || !firebase.auth) {
            addAIMessage(
                "Firebase authentication is not available. Please check firebase.js.",
                "error"
            );

            return;
        }

        const user = firebase.auth().currentUser;

        if (!user) {
            addAIMessage(
                "Please log in before using the AI Study Assistant.",
                "error"
            );

            return;
        }

        addAIMessage(message, "user");

        aiInput.value = "";

        aiSendButton.disabled = true;
        aiSendButton.textContent = "Thinking...";

        const replyElement = addAIMessage(
            "Thinking about your question...",
            "assistant"
        );

        try {
            const token = await user.getIdToken();

            const response = await fetch(AI_API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify({
                    message
                })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(
                    data.error || `Request failed (${response.status})`
                );
            }

            replyElement.textContent =
                data.reply || "Sorry, no answer was returned.";

        } catch (error) {
            console.error("ClassConnect AI error:", error);

            replyElement.textContent =
                `AI request failed: ${error.message}`;

            replyElement.classList.add("error");

        } finally {
            aiSendButton.disabled = false;
            aiSendButton.textContent = "Send";
            aiInput.focus();

            aiMessages.scrollTop = aiMessages.scrollHeight;
        }
    });

    console.log("ClassConnect AI Assistant initialized successfully.");
}

// Run whether script loads before or after DOMContentLoaded.
if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeClassConnectAI,
        { once: true }
    );
} else {
    initializeClassConnectAI();
}

// ======================================================
// INITIALIZE DASHBOARD
// ======================================================

loadAssignments();

console.log("ClassConnect dashboard initialized.");