const authForm = document.querySelector("#auth-form");
const authStatus = document.querySelector("#auth-status");
const submitButton = authForm.querySelector('button[type="submit"]');
const isRegistering = document.body.dataset.page === "register";
const endpoint = isRegistering ? "./api/signup" : "./api/login";

function setStatus(message, isError = false) {
  authStatus.textContent = message;
  authStatus.classList.toggle("status-error", isError);
}

async function restoreSession() {
  try {
    const response = await fetch("./api/me", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not check your account.");
    }
    if (data.user) {
      window.location.replace("./index.html");
      return;
    }
    setStatus(isRegistering ? "Create your account to start chatting." : "Sign in to open your chats.");
  } catch (error) {
    console.error("Could not restore the account session.", error);
    setStatus("Could not connect to the account server. Check that the Python server is running.", true);
  }
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  setStatus(isRegistering ? "Creating your account…" : "Signing you in…");

  try {
    const fields = new FormData(authForm);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        username: fields.get("username"),
        password: fields.get("password")
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || (isRegistering ? "Could not create your account." : "Could not sign in."));
    }

    window.location.replace("./index.html");
  } catch (error) {
    console.error("Account request failed.", error);
    setStatus(error.message || "Could not complete the account request. Please try again.", true);
  } finally {
    submitButton.disabled = false;
  }
});

restoreSession();
