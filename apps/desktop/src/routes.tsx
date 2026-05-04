import { createBrowserRouter } from "react-router-dom";
import { AppChrome } from "./AppChrome";
import { IndexRoute } from "./routes/index";
import { CockpitRoute } from "./routes/runs.$runId.cockpit";

export const router = createBrowserRouter([
  {
    element: <AppChrome />,
    children: [
      { path: "/", element: <IndexRoute /> },
      { path: "/runs/:runId/cockpit", element: <CockpitRoute /> },
    ],
  },
]);
