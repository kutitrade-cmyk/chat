const pageScripts = {
  login: "auth.js",
  register: "auth.js",
  inbox: "inbox.js",
  conversation: "conversation.js",
  profile: "profile.js"
};

const page = document.body.dataset.page;
const pageScript = pageScripts[page];

if (!pageScript) {
  console.error(`No application script is configured for page "${page}".`);
} else {
  const script = document.createElement("script");
  script.src = `./${pageScript}`;
  script.defer = true;
  script.addEventListener("error", () => {
    console.error(`Could not load the ${page} page script.`);
  });
  document.head.append(script);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.error("Could not register the service worker.", error);
  });
}
