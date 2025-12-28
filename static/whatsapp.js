// Global State
const state = {
  selectedPhone: null,
  contacts: [],
  messages: [],
  offset: 0,
  limit: 20,
  autoRefresh: true,
  lastMessageCount: {},
  lastContactUpdate: {},
  newMessageAlerts: {},
  filters: {
    byDate: false,
    date: null,
    onlyFollowUp: false,
    onlyUnread: false,
  },
};

let autoRefreshInterval = null;
let contactRefreshInterval = null;

// Utility Functions
function getAvatarColor(name) {
  if (!name) return 2;
  return (
    Math.abs(
      name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
    ) % 8
  );
}

function getAvatarInitials(name) {
  if (!name || name === "Unknown") return "?";
  const words = name.split(" ");
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function formatTime(timestamp) {
  const date = new Date(timestamp);

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, "0");

  return `${displayHours}:${displayMinutes} ${ampm}`;
}

function formatContactTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();

  const diff = now - date;

  if (diff < 86400000) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes.toString().padStart(2, "0");
    return `${displayHours}:${displayMinutes} ${ampm}`;
  } else if (diff < 172800000) {
    return "Yesterday";
  } else if (diff < 604800000) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return days[date.getDay()];
  } else {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Check if message is a WhatsApp reaction
function isReaction(message) {
  // Check if message is empty/blank or contains only whitespace
  const text = message.trim();
  if (!text) return false;

  // Check for common reaction patterns
  // Reactions often come as just emoji characters
  const emojiRegex =
    /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{1F004}\u{1F0CF}\u{1F170}-\u{1F171}\u{1F17E}-\u{1F17F}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F201}-\u{1F202}\u{1F21A}\u{1F22F}\u{1F232}-\u{1F23A}\u{1F250}-\u{1F251}\u{1F004}\u{1F0CF}\u{1F170}-\u{1F251}]+$/u;

  return emojiRegex.test(text) && text.length <= 10;
}

// Check if a date matches the filter date (ignoring time)
function isSameDate(timestamp, filterDate) {
  const messageDate = new Date(timestamp);
  const filter = new Date(filterDate);

  return (
    messageDate.getFullYear() === filter.getFullYear() &&
    messageDate.getMonth() === filter.getMonth() &&
    messageDate.getDate() === filter.getDate()
  );
}

// API Functions

// Load persisted alerts from backend
async function loadAlertsFromBackend() {
  try {
    const response = await fetch("/api/alerts");
    const data = await response.json();

    // Populate the alerts object
    if (data.alerts && Array.isArray(data.alerts)) {
      data.alerts.forEach((phone) => {
        state.newMessageAlerts[phone] = true;
      });
      console.log(
        `📥 Loaded ${data.alerts.length} persisted alerts from backend`
      );
    }
  } catch (error) {
    console.error("Error loading alerts:", error);
  }
}
async function fetchContacts() {
  try {
    const params = new URLSearchParams({
      only_follow_up: state.filters.onlyFollowUp,
    });

    // Add date filter if enabled
    if (state.filters.byDate && state.filters.date) {
      params.append("filter_date", state.filters.date);
    }

    const response = await fetch(`/api/contacts?${params}`);
    const newContacts = await response.json();

    // Check for new messages in contacts
    newContacts.forEach((contact) => {
      const oldContact = state.contacts.find((c) => c.phone === contact.phone);

      if (oldContact) {
        if (contact.last_time !== oldContact.last_time) {
          console.log(
            `🔔 New activity for ${contact.client_name || contact.phone}`
          );

          if (
            contact.phone !== state.selectedPhone &&
            (contact.last_direction === "user" ||
              contact.last_direction === "incoming")
          ) {
            checkAndSetNewMessageAlert(contact.phone);
          }
        }
      }
    });

    state.contacts = newContacts;
    renderContacts();
  } catch (error) {
    console.error("Error fetching contacts:", error);
  }
}

async function checkAndSetNewMessageAlert(phone) {
  try {
    const response = await fetch(`/api/automation/${phone}`);
    const data = await response.json();

    if (!data.automation_enabled) {
      state.newMessageAlerts[phone] = true;

      // Persist to backend
      await fetch(`/api/alerts/${phone}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ has_alert: true }),
      });

      console.log(`🟢 New message alert set for ${phone} (Chatbot is OFF)`);
      renderContacts();
    } else {
      console.log(
        `⚪ Message received for ${phone} but Chatbot is ON - no alert`
      );
    }
  } catch (error) {
    console.error("Error checking automation status:", error);
  }
}

async function fetchConversation(phone) {
  try {
    const params = new URLSearchParams({
      limit: state.limit,
      offset: state.offset,
    });
    const response = await fetch(`/api/conversation/${phone}?${params}`);
    const newMessages = await response.json();

    const currentCount = newMessages.length;
    const previousCount = state.lastMessageCount[phone] || 0;

    if (currentCount > previousCount && previousCount > 0) {
      console.log(`🔔 New message for ${phone}`);
    }

    state.lastMessageCount[phone] = currentCount;
    state.messages = newMessages;

    // Update pagination info
    updatePaginationInfo();

    renderMessages();
    await loadAutomationStatus(phone);

    if (state.newMessageAlerts[phone]) {
      delete state.newMessageAlerts[phone];

      // Clear from backend
      await fetch(`/api/alerts/${phone}`, { method: "DELETE" });

      console.log(`✅ Cleared alert for ${phone} (conversation opened)`);
      renderContacts();
    }
  } catch (error) {
    console.error("Error fetching conversation:", error);
  }
}

// Update pagination information and button states
function updatePaginationInfo() {
  const start = state.offset + 1;
  const end = state.offset + state.messages.length;

  document.getElementById(
    "paginationInfo"
  ).textContent = `Showing ${start}–${end}`;

  // Disable/enable Previous button
  const prevBtn = document.getElementById("prevBtn");
  if (state.offset === 0) {
    prevBtn.disabled = true;
    prevBtn.style.opacity = "0.5";
    prevBtn.style.cursor = "not-allowed";
  } else {
    prevBtn.disabled = false;
    prevBtn.style.opacity = "1";
    prevBtn.style.cursor = "pointer";
  }

  // Disable/enable Next button
  const nextBtn = document.getElementById("nextBtn");
  if (state.messages.length < state.limit) {
    // Less than limit means no more messages
    nextBtn.disabled = true;
    nextBtn.style.opacity = "0.5";
    nextBtn.style.cursor = "not-allowed";
  } else {
    nextBtn.disabled = false;
    nextBtn.style.opacity = "1";
    nextBtn.style.cursor = "pointer";
  }

  console.log(
    `📄 Pagination: Showing ${start}-${end}, Offset: ${state.offset}, Limit: ${state.limit}`
  );
}

function toggleInputArea(automationEnabled) {
  const messageInput = document.getElementById("messageInput");
  const sendBtn = document.getElementById("sendBtn");
  const fileInput = document.getElementById("fileInput");
  const fileLabel = document.querySelector(".file-upload-label");
  const emojiBtn = document.getElementById("emojiBtn");

  if (automationEnabled) {
    // Chatbot is ON - Disable input
    messageInput.disabled = true;
    messageInput.placeholder = "🤖 Chatbot is handling messages";
    sendBtn.disabled = true;
    sendBtn.style.opacity = "0.5";
    sendBtn.style.cursor = "not-allowed";
    fileLabel.style.opacity = "0.5";
    fileLabel.style.pointerEvents = "none";
    emojiBtn.style.opacity = "0.5";
    emojiBtn.style.pointerEvents = "none";

    console.log("🤖 Input disabled - Chatbot is ON");
  } else {
    // Chatbot is OFF - Enable input
    messageInput.disabled = false;
    messageInput.placeholder = "Type a message";
    sendBtn.disabled = false;
    sendBtn.style.opacity = "1";
    sendBtn.style.cursor = "pointer";
    fileLabel.style.opacity = "1";
    fileLabel.style.pointerEvents = "auto";
    emojiBtn.style.opacity = "1";
    emojiBtn.style.pointerEvents = "auto";

    console.log("👤 Input enabled - Manual mode");
  }
}

async function loadAutomationStatus(phone) {
  try {
    const response = await fetch(`/api/automation/${phone}`);
    const data = await response.json();
    document.getElementById("automationToggle").checked =
      data.automation_enabled;

    // Enable/disable input area based on automation status
    toggleInputArea(data.automation_enabled);
  } catch (error) {
    console.error("Error loading automation:", error);
  }
}

async function setAutomationStatus(phone, enabled) {
  try {
    await fetch(`/api/automation/${phone}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automation_enabled: enabled }),
    });

    // Toggle input area immediately
    toggleInputArea(enabled);

    if (enabled && state.newMessageAlerts[phone]) {
      delete state.newMessageAlerts[phone];

      // Clear from backend
      await fetch(`/api/alerts/${phone}`, { method: "DELETE" });

      console.log(`✅ Cleared alert for ${phone} (Chatbot turned ON)`);
      renderContacts();
    }
  } catch (error) {
    console.error("Error setting automation:", error);
  }
}

async function sendMessage(phone, message) {
  try {
    const response = await fetch("/api/send_message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message, type: "text" }),
    });

    if (response.ok) {
      document.getElementById("messageInput").value = "";
      setTimeout(() => fetchConversation(phone), 500);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error sending message:", error);
    return false;
  }
}

async function updateMessage(msgId, data) {
  try {
    await fetch(`/api/message/${msgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    fetchConversation(state.selectedPhone);
  } catch (error) {
    console.error("Error updating message:", error);
  }
}

async function deleteConversation(phone) {
  if (!confirm("Delete all messages with this contact?")) return;

  try {
    await fetch(`/api/conversation/${phone}`, { method: "DELETE" });
    state.messages = [];
    renderMessages();
    fetchContacts();
  } catch (error) {
    console.error("Error deleting conversation:", error);
  }
}

// Render Functions
function renderContacts() {
  const container = document.getElementById("contactsList");
  container.innerHTML = "";

  const searchQuery = document
    .getElementById("searchContacts")
    .value.toLowerCase();

  let filteredContacts = state.contacts.filter((contact) => {
    const name = (contact.client_name || "").toLowerCase();
    const phone = contact.phone.toLowerCase();
    return name.includes(searchQuery) || phone.includes(searchQuery);
  });

  // Apply unread filter if enabled (frontend-only filter)
  if (state.filters.onlyUnread) {
    filteredContacts = filteredContacts.filter((contact) => {
      // Show contacts with green badge (new message alerts)
      return state.newMessageAlerts[contact.phone] === true;
    });
  }

  if (filteredContacts.length === 0) {
    container.innerHTML =
      '<div style="padding: 20px; text-align: center; color: #667781;">No contacts found</div>';
    return;
  }

  filteredContacts.forEach((contact) => {
    const div = document.createElement("div");
    div.className = "chat-item";
    if (contact.phone === state.selectedPhone) {
      div.classList.add("active");
    }

    const colorIndex = getAvatarColor(contact.client_name);
    const initials = getAvatarInitials(contact.client_name);
    const time = formatContactTime(contact.last_time);
    const preview = contact.last_message
      ? escapeHtml(contact.last_message.substring(0, 40)) +
        (contact.last_message.length > 40 ? "..." : "")
      : "No messages";

    const contactName = escapeHtml(contact.client_name || "Unknown");
    const displayName = contact.follow_up_open
      ? `${contactName} - <span style="color: #ff4444; font-weight: 600;">Follow up</span>`
      : contactName;

    const showNewMessageBadge = state.newMessageAlerts[contact.phone] || false;

    div.innerHTML = `
            <div class="chat-avatar avatar-color-${colorIndex}">${initials}</div>
            <div class="chat-info">
                <div class="chat-header">
                    <span class="chat-name">${displayName}</span>
                    <span class="chat-time">${time}</span>
                </div>
                <div class="chat-preview">
                    ${preview}
                    ${
                      showNewMessageBadge
                        ? '<span class="unread-badge">1</span>'
                        : ""
                    }
                </div>
            </div>
        `;

    div.onclick = () => selectContact(contact.phone);
    container.appendChild(div);
  });
}

function selectContact(phone) {
  state.selectedPhone = phone;
  state.offset = 0; // Reset to first page when selecting new contact
  fetchConversation(phone);
  renderContacts();

  const contact = state.contacts.find((c) => c.phone === phone);
  if (contact) {
    document.getElementById("chatHeader").style.display = "flex";
    document.getElementById("inputArea").style.display = "flex";
    document.getElementById("paginationBar").style.display = "flex";

    const colorIndex = getAvatarColor(contact.client_name);
    const initials = getAvatarInitials(contact.client_name);

    document.getElementById(
      "chatAvatar"
    ).className = `chat-header-avatar avatar-color-${colorIndex}`;
    document.getElementById("chatAvatar").textContent = initials;
    const chatNameEl = document.getElementById("chatName");
    chatNameEl.innerHTML = `
            <span id="contactNameText">${escapeHtml(
              contact.client_name || "Unknown"
            )}</span>
            <span 
                id="editContactName"
                title="Edit contact name"
                style="
                    margin-left: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    opacity: 0.7;
                "
            >✏️</span>
`;

    attachEditNameHandler(phone, contact.client_name || "Unknown");

    document.getElementById("followUpToggle").checked =
      contact.follow_up_open || false;

    // Load automation status and toggle input area accordingly
    loadAutomationStatus(phone);
  }
}

function attachEditNameHandler(phone, currentName) {
  const editIcon = document.getElementById("editContactName");
  if (!editIcon) return;

  editIcon.onclick = async (e) => {
    e.stopPropagation();

    const newName = prompt(
      "Enter display name for this contact:",
      currentName || ""
    );

    if (!newName || newName.trim() === currentName) return;

    try {
      await fetch(
        `/api/contacts/${phone}?display_name=${encodeURIComponent(
          newName.trim()
        )}`,
        {
          method: "PATCH",
        }
      );

      // Refresh UI
      await fetchContacts();
      await fetchConversation(phone);
    } catch (err) {
      console.error("Failed to update contact name", err);
      alert("Failed to update contact name");
    }
  };
}

function getStatusIcon(status) {
  if (!status) return "";

  switch (status) {
    case "sent":
      return "✓";
    case "delivered":
      return "✓✓";
    case "read":
      return '<span class="read">✓✓</span>';
    case "failed":
      return '<span class="failed">⚠</span>';
    default:
      return "";
  }
}

function renderMessages() {
  const container = document.getElementById("chatMessages");

  if (!state.messages || state.messages.length === 0) {
    container.innerHTML = `
            <div class="empty-chat">
                <div class="empty-icon">💬</div>
                <h2>No messages yet</h2>
                <p>Start a conversation</p>
            </div>
        `;
    return;
  }

  const wasScrolledToBottom =
    container.scrollHeight - container.scrollTop <=
    container.clientHeight + 100;

  container.innerHTML = "";

  let currentDate = null;

  state.messages.forEach((msg) => {
    const date = new Date(msg.timestamp);
    const dateStr = date.toDateString();

    if (currentDate !== dateStr) {
      currentDate = dateStr;

      const today = new Date().toDateString();
      const yesterday = new Date(Date.now() - 86400000).toDateString();

      let dateLabel;
      if (dateStr === today) {
        dateLabel = "Today";
      } else if (dateStr === yesterday) {
        dateLabel = "Yesterday";
      } else {
        const months = [
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ];
        dateLabel = `${
          months[date.getMonth()]
        } ${date.getDate()}, ${date.getFullYear()}`;
      }

      const dateDivider = document.createElement("div");
      dateDivider.className = "date-divider";
      dateDivider.innerHTML = `<span class="date-label">${dateLabel}</span>`;
      container.appendChild(dateDivider);
    }

    // Skip rendering blank/empty messages (likely reactions that weren't properly captured)
    if (!msg.message || msg.message.trim() === "") {
      console.log("⚠️ Skipping blank message (likely a reaction)", msg);
      return;
    }

    const direction = msg.direction === "user" ? "received" : "sent";

    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${direction}`;

    // Check if this is a reaction
    const messageIsReaction = isReaction(msg.message);

    let messageText = escapeHtml(msg.message).replace(/\n/g, "<br>");
    let metaHtml = "";

    // Add special styling for reactions
    if (messageIsReaction) {
      messageDiv.classList.add("reaction-message");
      messageText = `<span class="reaction-emoji">${msg.message}</span>`;
    }

    if (msg.notes) {
      metaHtml += `<div class="message-meta">📝 ${escapeHtml(msg.notes)}</div>`;
    }
    if (msg.handled_by) {
      metaHtml += `<div class="message-meta">👤 ${escapeHtml(
        msg.handled_by
      )}</div>`;
    }

    const statusIcon = direction === "sent" ? getStatusIcon(msg.status) : "";
    const statusClass = msg.status === "read" ? "status-read" : "";

    messageDiv.innerHTML = `
            <div class="message-bubble">
               <div class="message-text">${messageText}</div>
               ${metaHtml}
               <div class="message-footer">
                   <span class="message-time">${formatTime(
                     msg.timestamp
                   )}</span>
                   <span class="message-status ${statusClass}">${statusIcon}</span>
               </div>
            </div>
`;
    container.appendChild(messageDiv);
  });

  // Update follow-up toggle based on latest message
  if (state.messages.length > 0) {
    const latest = state.messages[state.messages.length - 1];
    document.getElementById("followUpToggle").checked =
      latest.follow_up_needed || false;
  }

  // Auto-scroll to bottom only if user was already at bottom
  if (wasScrolledToBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

// Event Listeners
document.getElementById("themeToggle").addEventListener("click", async () => {
  const response = await fetch("/api/toggle_theme", { method: "POST" });
  const data = await response.json();

  document.body.className = `${data.theme}-theme`;

  const sunIcon = document.querySelector(".sun-icon");
  const moonIcon = document.querySelector(".moon-icon");

  if (data.theme === "dark") {
    sunIcon.style.display = "block";
    moonIcon.style.display = "none";
  } else {
    sunIcon.style.display = "none";
    moonIcon.style.display = "block";
  }
});

document.getElementById("addContactBtn").onclick = async () => {
  const addBtn = document.getElementById("addContactBtn");
  if (addBtn) {
    addBtn.onclick = async () => {
      const phone = prompt("Enter phone number (with country code):");
      if (!phone || phone.length < 8) return;

      const display_name = prompt("Enter display name:");
      if (!display_name) return;

      try {
        // 1️⃣ Create contact metadata
        await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: phone.trim(),
            display_name: display_name.trim(),
            notes: "",
          }),
        });

        // 2️⃣ Try sending first message (non-blocking)
        try {
          await sendMessage(phone.trim(), "Hello 👋");
        } catch (e) {
          console.warn("Initial message failed", e);
        }

        // 3️⃣ Refresh UI
        await fetchContacts();
        selectContact(phone.trim());

        alert("Contact created");
      } catch (err) {
        console.error(err);
        alert("Failed to create contact");
      }
    };
  }
};

document.getElementById("filterToggleBtn").addEventListener("click", () => {
  const panel = document.getElementById("filtersPanel");
  const btn = document.getElementById("filterToggleBtn");
  if (panel.style.display === "none") {
    panel.style.display = "block";
    btn.textContent = "▼ Filters";
  } else {
    panel.style.display = "none";
    btn.textContent = "▶ Filters";
  }
});

document.getElementById("filterByDate").addEventListener("change", (e) => {
  document.getElementById("filterDate").disabled = !e.target.checked;
  state.filters.byDate = e.target.checked;

  // If unchecking, clear the filter
  if (!e.target.checked) {
    state.filters.date = null;
    fetchContacts();
  }
});

document.getElementById("applyFilters").addEventListener("click", () => {
  // Get date filter value
  if (state.filters.byDate) {
    state.filters.date = document.getElementById("filterDate").value;
    if (!state.filters.date) {
      alert("Please select a date");
      return;
    }
  } else {
    state.filters.date = null;
  }

  // Get follow-up filter value
  state.filters.onlyFollowUp = document.getElementById("filterOnlyFU").checked;

  // Get unread filter value
  state.filters.onlyUnread = document.getElementById("filterUnread").checked;

  // Apply filters
  console.log("📋 Filters applied:", state.filters);
  fetchContacts();
});

// Remove Filters button event listener
document.getElementById("removeFilters").addEventListener("click", () => {
  // Clear all filter states
  state.filters.byDate = false;
  state.filters.date = null;
  state.filters.onlyFollowUp = false;
  state.filters.onlyUnread = false;

  // Reset UI elements
  document.getElementById("filterByDate").checked = false;
  document.getElementById("filterDate").value = "";
  document.getElementById("filterDate").disabled = true;
  document.getElementById("filterOnlyFU").checked = false;
  document.getElementById("filterUnread").checked = false;

  // Refresh contacts without filters
  console.log("🗑️ All filters removed");
  fetchContacts();
});

document
  .getElementById("searchContacts")
  .addEventListener("input", renderContacts);

document.getElementById("automationToggle").addEventListener("change", (e) => {
  if (state.selectedPhone) {
    setAutomationStatus(state.selectedPhone, e.target.checked);
  }
});

document
  .getElementById("followUpToggle")
  .addEventListener("change", async (e) => {
    if (
      !state.selectedPhone ||
      !state.messages ||
      state.messages.length === 0
    ) {
      e.target.checked = !e.target.checked;
      alert("No messages to update");
      return;
    }

    try {
      const latest = state.messages[state.messages.length - 1];

      const data = {
        follow_up_needed: e.target.checked,
      };

      await fetch(`/api/message/${latest.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      console.log(`✅ Follow-up status updated to: ${e.target.checked}`);

      setTimeout(() => {
        fetchConversation(state.selectedPhone);
        fetchContacts();
      }, 300);
    } catch (error) {
      console.error("Error updating follow-up status:", error);
      alert("Failed to update follow-up status");
      e.target.checked = !e.target.checked;
    }
  });

document.getElementById("deleteAllBtn").addEventListener("click", () => {
  if (state.selectedPhone) {
    deleteConversation(state.selectedPhone);
  }
});

document.getElementById("prevBtn").addEventListener("click", () => {
  if (state.offset > 0 && state.selectedPhone) {
    state.offset = Math.max(0, state.offset - state.limit);
    console.log(`⬅️ Going to previous page. New offset: ${state.offset}`);
    fetchConversation(state.selectedPhone);
  }
});

document.getElementById("nextBtn").addEventListener("click", () => {
  if (state.selectedPhone && state.messages.length === state.limit) {
    state.offset += state.limit;
    console.log(`➡️ Going to next page. New offset: ${state.offset}`);
    fetchConversation(state.selectedPhone);
  }
});

document.getElementById("sendBtn").addEventListener("click", async () => {
  const input = document.getElementById("messageInput");
  const message = input.value.trim();
  if (message && state.selectedPhone) {
    const success = await sendMessage(state.selectedPhone, message);
    if (success) {
      input.value = "";
    }
  }
});

document.getElementById("messageInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("sendBtn").click();
  }
});

document.getElementById("emojiBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const picker = document.getElementById("emojiPicker");
  picker.style.display = picker.style.display === "none" ? "block" : "none";
});

document.addEventListener("click", (e) => {
  const picker = document.getElementById("emojiPicker");
  const emojiBtn = document.getElementById("emojiBtn");
  if (picker && !picker.contains(e.target) && !emojiBtn.contains(e.target)) {
    picker.style.display = "none";
  }
});

document.getElementById("emojiPicker").addEventListener("click", (e) => {
  if (
    e.target.tagName === "SPAN" ||
    (e.target.textContent &&
      e.target.textContent.match(/[\u{1F600}-\u{1F64F}]/u))
  ) {
    const emoji = e.target.textContent.trim();
    if (emoji) {
      const input = document.getElementById("messageInput");
      const cursorPos = input.selectionStart;
      const textBefore = input.value.substring(0, cursorPos);
      const textAfter = input.value.substring(cursorPos);
      input.value = textBefore + emoji + textAfter;
      input.focus();
      input.selectionStart = input.selectionEnd = cursorPos + emoji.length;
    }
  }
});

const emojiGrid = document.querySelector(".emoji-grid");
if (emojiGrid) {
  const emojis = emojiGrid.textContent.trim().split(/\s+/);
  emojiGrid.innerHTML = emojis.map((emoji) => `<span>${emoji}</span>`).join("");
}

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0 || !state.selectedPhone) return;

  for (let file of files) {
    if (file.size > 16 * 1024 * 1024) {
      alert(`File "${file.name}" is too large. WhatsApp limit is 16MB.`);
      continue;
    }

    try {
      const success = await sendFileMessage(state.selectedPhone, file);

      if (success) {
        console.log(`File "${file.name}" uploaded successfully`);
      } else {
        alert(`Failed to upload "${file.name}"`);
      }
    } catch (error) {
      console.error("Error uploading file:", error);
      alert(`Error uploading "${file.name}": ${error.message}`);
    }
  }

  e.target.value = "";
});

async function sendFileMessage(phone, file) {
  try {
    const formData = new FormData();
    formData.append("phone", phone);
    formData.append("file", file); // RAW FILE (binary)

    const response = await fetch("/api/send_file", {
      method: "POST",
      body: formData, // multipart/form-data auto
    });

    if (response.ok) {
      setTimeout(() => fetchConversation(phone), 500);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Error sending file:", error);
    return false;
  }
}

fetchContacts();

function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(() => {
    if (state.selectedPhone) {
      fetchConversation(state.selectedPhone);
    }
  }, 2000);

  if (contactRefreshInterval) clearInterval(contactRefreshInterval);
  contactRefreshInterval = setInterval(() => {
    fetchContacts();
  }, 5000);
}

document.addEventListener("DOMContentLoaded", async function () {
  // Load persisted alerts first
  await loadAlertsFromBackend();

  // Then fetch contacts (which will show the alerts)
  await fetchContacts();

  // Start auto-refresh
  startAutoRefresh();

  console.log("🔄 Real-time updates enabled (always on)");
  console.log("📱 Messages refresh: Every 2 seconds");
  console.log("👥 Contacts refresh: Every 5 seconds");
  console.log("🟢 New message alerts: Active when chatbot is OFF");
});
