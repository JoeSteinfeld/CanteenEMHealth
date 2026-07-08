import { NavLink, Outlet } from "react-router-dom";
import { logout } from "./auth";
import { NAV_ITEMS } from "./nav";
import { APP_VERSION } from "./version";

type AppShellProps = {
  showSignOut: boolean;
  onSignOut: () => void;
};

export function AppShell({ showSignOut, onSignOut }: AppShellProps) {
  return (
    <div className="app-shell">
      <nav className="app-sidebar" aria-label="Main navigation">
        <div className="app-sidebar-brand">Canteen EM Health</div>
        <ul className="app-nav" role="list">
          {NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  `app-nav-link${isActive ? " app-nav-link-active" : ""}`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="app-sidebar-bottom">
          <p className="app-sidebar-version">Version {APP_VERSION}</p>
          {showSignOut && (
            <div className="app-sidebar-foot">
              <button
                type="button"
                className="app-sidebar-sign-out"
                onClick={() => {
                  void logout().then(onSignOut);
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </nav>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
