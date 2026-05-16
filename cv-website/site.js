const chatWidget = document.querySelector("[data-chat-widget]");
const chatLaunch = document.querySelector("[data-chat-launch]");
const chatLog = document.querySelector("[data-chat-log]");
const chatOptions = document.querySelector("[data-chat-options]");
const cookiePanel = document.querySelector("[data-cookie-panel]");

const nowStamp = () => new Date().toLocaleDateString("en-US", {
  month: "numeric",
  day: "numeric",
  year: "2-digit"
}) + ", " + new Date().toLocaleTimeString("en-US", {
  hour: "numeric",
  minute: "2-digit"
});

const optionSets = {
  home: ["Schedule Tour", "Pricing & Availability", "Office Hours", "Apply Online", "Pet Policy", "Amenities", "Current Resident"],
  bedrooms: ["Studio", "1 Bedroom", "2 Bedroom", "3 Bedroom"]
};

function appendMessage(text, sender = "roxy") {
  if (!chatLog) return;
  if (sender === "user") {
    chatLog.insertAdjacentHTML("beforeend", `<p class="chat-time">${nowStamp()}</p><div class="bubble bubble--user">${text}</div>`);
  } else {
    chatLog.insertAdjacentHTML("beforeend", `<p class="chat-time">${nowStamp()}</p><div class="bubble">${text}</div>`);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setOptions(name) {
  if (!chatOptions) return;
  chatOptions.innerHTML = optionSets[name].map((label) => `<button class="chat-option" type="button" data-chat-choice="${label}">${label}</button>`).join("");
}

function openChat() {
  chatWidget.hidden = false;
  chatLaunch.hidden = true;
}

function closeChat() {
  chatWidget.hidden = true;
  chatLaunch.hidden = false;
}

if (chatWidget && chatLaunch) {
  closeChat();
  setOptions("home");
  chatLaunch.addEventListener("click", openChat);
  document.querySelectorAll("[data-chat-min], [data-chat-close]").forEach((button) => button.addEventListener("click", closeChat));
  chatOptions.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-chat-choice]");
    if (!choice) return;
    const text = choice.dataset.chatChoice;
    appendMessage(text, "user");
    if (text === "Pricing & Availability") {
      appendMessage("Thank you for your interest in Canyon Vista - OLD. We offer studio, 1, 2, and 3-bedroom apartments. Could you please let me know the number of bedrooms you're interested in? This will help me provide you with more accurate pricing and availability.");
      setOptions("bedrooms");
      return;
    }
    if (optionSets.bedrooms.includes(text)) {
      appendMessage(`Great. I can help with ${text.toLowerCase()} options. In this mock, availability is captured locally so you can test cookie, chat, and conversion behavior.`);
      setOptions("home");
      return;
    }
    const replies = {
      "Schedule Tour": "You can schedule an in-person, virtual, or self-guided tour. Please choose a preferred date on the Schedule a Tour page.",
      "Office Hours": "Our office hours are Monday-Tuesday 9 AM-6 PM, Wednesday 10 AM-6 PM, Thursday-Friday 9 AM-6 PM, Saturday 10 AM-5 PM, and Sunday closed.",
      "Apply Online": "I can take you to the application flow. For this mock, the Apply buttons are local test links.",
      "Pet Policy": "Canyon Vista is pet friendly and welcomes cats and dogs with restrictions. The community also includes a pet wash area.",
      "Amenities": "Residents enjoy a resort-style pool and spa, clubhouse, fitness center, yoga studio, playgrounds, EV charging, and more.",
      "Current Resident": "Current residents can use the resident portal link in the header or footer."
    };
    appendMessage(replies[text] || "Please enter a question and the mock will capture it locally.");
  });
}

document.querySelectorAll("[data-gallery-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.galleryFilter;
    document.querySelectorAll("[data-gallery-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    document.querySelectorAll("[data-gallery-item]").forEach((tile) => {
      tile.hidden = filter !== "all" && tile.dataset.galleryItem !== filter;
    });
  });
});

document.querySelectorAll("form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    localStorage.setItem(`cv_form_${Date.now()}`, JSON.stringify(Object.fromEntries(new FormData(form).entries())));
    alert("Mock form captured locally for testing.");
  });
});

if (cookiePanel) {
  const cookieBoxes = [...document.querySelectorAll("[data-cookie-option]")];
  const savedConsent = localStorage.getItem("cv_cookie_mock");
  if (savedConsent) cookiePanel.hidden = true;
  document.querySelector("[data-cookie-save]")?.addEventListener("click", () => {
    const value = Object.fromEntries(cookieBoxes.map((box) => [box.dataset.cookieOption, box.checked]));
    localStorage.setItem("cv_cookie_mock", JSON.stringify(value));
    document.cookie = `cv_cookie_mock=${encodeURIComponent(JSON.stringify(value))}; path=/; max-age=31536000; SameSite=Lax`;
    cookiePanel.hidden = true;
  });
  document.querySelector("[data-cookie-accept]")?.addEventListener("click", () => {
    const value = { analytics: true, marketing: true, chat: true };
    localStorage.setItem("cv_cookie_mock", JSON.stringify(value));
    document.cookie = `cv_cookie_mock=${encodeURIComponent(JSON.stringify(value))}; path=/; max-age=31536000; SameSite=Lax`;
    cookiePanel.hidden = true;
  });
  document.querySelector("[data-cookie-reset]")?.addEventListener("click", () => {
    localStorage.removeItem("cv_cookie_mock");
    document.cookie = "cv_cookie_mock=; path=/; max-age=0; SameSite=Lax";
    cookieBoxes.forEach((box) => { box.checked = false; });
  });
}
