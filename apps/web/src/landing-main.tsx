import React from "react";
import ReactDOM from "react-dom/client";
import { PublicLandingEntry } from "./features/landing/PublicLandingEntry";

const container = document.getElementById("root")!;
const page = <React.StrictMode><PublicLandingEntry pathname={window.location.pathname} /></React.StrictMode>;
// Dev HTML is empty; published HTML already contains the identical page tree.
if (container.hasChildNodes()) ReactDOM.hydrateRoot(container, page);
else ReactDOM.createRoot(container).render(page);
