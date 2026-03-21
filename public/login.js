const $ = (id) => document.getElementById(id);

function setStatus(text, ok = false) {
  const el = $("formStatus");
  el.textContent = text || "";
  el.classList.toggle("form-status--ok", !!ok);
  el.classList.toggle("form-status--err", !ok && !!text);
}

async function submitAuth(ev) {
  ev.preventDefault();
  setStatus("");
  const username = String($("username").value || "").trim();
  const password = String($("password").value || "");

  if (!username || !password) {
    setStatus("Vyplňte uživatelské jméno i heslo.");
    return;
  }

  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) {
      setStatus(j.error || "Operace se nezdařila.");
      return;
    }
    setStatus("Přihlášení proběhlo.", true);
    window.location.href = "/";
  } catch {
    setStatus("Chyba spojení se serverem.");
  }
}

$("authForm").addEventListener("submit", submitAuth);
