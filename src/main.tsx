import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/space-grotesk";
import { App } from "./App";
import "./styles.css";
import "./light-theme.css";
import "./theme-presets.css";
import "./components/SessionReadyAttention.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
