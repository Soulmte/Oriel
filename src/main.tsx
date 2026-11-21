import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateStorageKeys } from "./lib/storageMigration";

// Preferences written by the pre-rename build are carried over once.
migrateStorageKeys();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
