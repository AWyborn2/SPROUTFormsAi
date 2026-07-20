import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { RootLayout } from './layouts/RootLayout.js';
import { AppShell } from './layouts/AppShell.js';
import { RequireAuth, RootRedirect } from './components/AuthGate.js';
import { ScreenPlaceholder } from './screens/ScreenPlaceholder.js';
import { LoginScreen } from './screens/onboarding/LoginScreen.js';
import { OrgSetupScreen } from './screens/onboarding/OrgSetupScreen.js';
import { BrandingScreen } from './screens/onboarding/BrandingScreen.js';
import { DashboardScreen } from './screens/DashboardScreen.js';
import { TemplatesScreen } from './screens/TemplatesScreen.js';
import { SubmissionsScreen } from './screens/SubmissionsScreen.js';
import { SubmissionDetailScreen } from './screens/SubmissionDetailScreen.js';
import { BuilderScreen } from './screens/builder/BuilderScreen.js';
import { ImportUploadScreen } from './screens/import/ImportUploadScreen.js';
import { ImportReviewScreen } from './screens/import/ImportReviewScreen.js';
import { ImportPublishScreen } from './screens/import/ImportPublishScreen.js';
import { FillScreen } from './screens/fill/FillScreen.js';
import { InviteScreen } from './screens/invite/InviteScreen.js';
import { TeamScreen } from './screens/enterprise/TeamScreen.js';
import { RolesScreen } from './screens/enterprise/RolesScreen.js';
import { AuditScreen } from './screens/enterprise/AuditScreen.js';
import { BillingScreen } from './screens/enterprise/BillingScreen.js';
import { WhiteLabelScreen } from './screens/enterprise/WhiteLabelScreen.js';
import { CompetencyScreen } from './screens/enterprise/CompetencyScreen.js';
import { MobileScreen } from './screens/mobile/MobileScreen.js';
import { SCREENS, type ScreenDef } from './lib/screens.js';

/** Screens implemented for real; everything else renders the Phase-0 placeholder. */
const REAL_SCREENS: Record<string, React.ReactNode> = {
  login: <LoginScreen />,
  'org-setup': <OrgSetupScreen />,
  branding: <BrandingScreen />,
  dashboard: <DashboardScreen />,
  templates: <TemplatesScreen />,
  builder: <BuilderScreen />,
  'import-1': <ImportUploadScreen />,
  'import-2': <ImportReviewScreen />,
  'import-3': <ImportPublishScreen />,
  submissions: <SubmissionsScreen />,
  'submission-detail': <SubmissionDetailScreen />,
  fill: <FillScreen />,
  invite: <InviteScreen />,
  team: <TeamScreen />,
  roles: <RolesScreen />,
  audit: <AuditScreen />,
  billing: <BillingScreen />,
  whitelabel: <WhiteLabelScreen />,
  competency: <CompetencyScreen />,
  mobile: <MobileScreen />,
};

function elementFor(s: ScreenDef): React.ReactNode {
  return REAL_SCREENS[s.key] ?? <ScreenPlaceholder screen={s} />;
}

const appScreens = SCREENS.filter((s) => s.shell === 'app');
// The mobile field app (/m) is authenticated — it posts real submissions —
// but renders its own device chrome, so it sits under RequireAuth WITHOUT AppShell.
const mobileScreens = SCREENS.filter((s) => s.shell === 'mobile');
// Everything else (onboarding + the public /fill/:token page) stays OUTSIDE
// RequireAuth — an external fill visitor is logged out by design.
const standaloneScreens = SCREENS.filter((s) => s.shell !== 'app' && s.shell !== 'mobile');

const appRoutes: RouteObject[] = appScreens.map((s) => ({
  path: s.path,
  element: elementFor(s),
}));

const mobileRoutes: RouteObject[] = mobileScreens.map((s) => ({
  path: s.path,
  element: elementFor(s),
}));

const standaloneRoutes: RouteObject[] = standaloneScreens.map((s) => ({
  path: s.path,
  element: elementFor(s),
}));

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <RootRedirect /> },
      ...standaloneRoutes,
      {
        element: <RequireAuth />,
        children: [{ element: <AppShell />, children: appRoutes }, ...mobileRoutes],
      },
      { path: '*', element: <RootRedirect /> },
    ],
  },
]);
