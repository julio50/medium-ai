import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./theme/theme"; // keeps data-theme on <html> in sync (index.html sets it first)

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />
);
