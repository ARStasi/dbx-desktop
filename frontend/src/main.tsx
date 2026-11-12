import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// macOS hides the title bar, so the layout leaves room for the window buttons.
if (navigator.userAgent.includes("Mac")) {
  document.documentElement.classList.add("mac");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
